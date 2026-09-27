// GetSetRacks: nodes that publish and read several named variables.
//
// The node itself comes from the Python definition (nodes.py) so that it is a
// first-class node type. This extension gives it its behaviour: one input socket
// per published variable, and KJNodes-style resolution so a GetNode can read a
// row by name.
//
// Two setter flavours share that machinery:
//   SetNodeRack      - the row's variable name is the label of the output that
//                      feeds it, so nothing has to be typed twice.
//   SetNodeRackNamed - the row's variable name comes from its own text field,
//                      for rows whose upstream label is not the variable name.
//
// GetNodeRack is the matching reader: one output per row, each with a dropdown
// of the names in scope. Autogrow cannot build it - an autogrow template forces
// its widget into a socket, so a row could not carry a name chooser.
//
// KJNodes resolves a name by scanning the graph and its ancestors for a node
// whose type is "SetNode", so a rack would not be found. Rather than duplicating
// that lookup, the two GetNode resolution hooks are wrapped to consult racks
// first and delegate every other lookup to KJNodes unchanged.

const { app } = window.comfyAPI.app;
const LGraphNode = LiteGraph.LGraphNode;

export const RACK_TYPE = "SetNodeRack";
export const NAMED_RACK_TYPE = "SetNodeRackNamed";
export const GET_RACK_TYPE = "GetNodeRack";
const RACK_TYPES = new Set([RACK_TYPE, NAMED_RACK_TYPE]);
/** A rack caps its rows; the largest panels in Warpdock need fifteen. */
const MAX_ROWS = 99;
const MAX_GRAPH_DEPTH = 64;
const ROW_TITLE_PREFIX = "SetNode Rack";
const GET_ROW_TITLE_PREFIX = "GetNode Rack";
const OPTIONAL_SLOT_SHAPE = 7;
/** Choosing this retires the row: its consumers drop and the rows below close up. */
const UNUSED_ROW_LABEL = "(unused)";

function is_unused_row_value(value)
{
	const text = String(value ?? "").trim();
	return text === "" || text === UNUSED_ROW_LABEL;
}

function graphIsLoading() {
	return Boolean(
		app?.configuringGraph ||
		window.comfyAPI?.changeTracker?.ChangeTracker?.isLoadingGraph
	);
}

function getLink(graph, linkId) {
	if (linkId == null || !graph) return null;
	if (graph.getLink) return graph.getLink(linkId);
	return graph._links instanceof Map ? graph._links.get(linkId) : graph._links?.[linkId] ?? null;
}

/** Input link of a slot without reading the deprecated `input.link` field. */
function inputLinkOf(node, index) {
	const slot = node.inputs?.[index];
	if (!slot) return null;
	// A detached node (created but not yet added) has no graph for the
	// framework's own lookup, so fall back to the link table rather than throw.
	if (node.graph && typeof node.getInputLink === "function") {
		try {
			const link = node.getInputLink(index);
			if (link) return link;
		} catch (error) {
			return null;
		}
	}
	return getLink(node.graph, slot.link);
}

function childGraphs(root) {
	const graphs = [root];
	const queue = [root];
	while (queue.length) {
		const current = queue.shift();
		for (const node of current._nodes ?? []) {
			if (node.subgraph && !graphs.includes(node.subgraph)) {
				graphs.push(node.subgraph);
				queue.push(node.subgraph);
			}
		}
	}
	return graphs;
}

function parentGraphOf(graph) {
	const root = graph.rootGraph ?? graph;
	if (graph === root) return null;
	for (const candidate of childGraphs(root)) {
		for (const node of candidate._nodes ?? []) {
			if (node.subgraph === graph) return candidate;
		}
	}
	return null;
}

/** Every graph that can see `graph`, closest first: the graph itself, then its ancestors. */
export function graphChain(graph) {
	const chain = [];
	const seen = new Set();
	let current = graph;
	while (current && !seen.has(current) && chain.length < MAX_GRAPH_DEPTH) {
		chain.push(current);
		seen.add(current);
		current = parentGraphOf(current);
	}
	return chain;
}

/**
 * The variable name suggested by the output that feeds a row, when there is a
 * usable one. An explicit label always wins. Without one only a subgraph
 * instance is trustworthy: its output is named after the interior output, which
 * is what the author called the value. A plain node's output name is the slot
 * name from its definition ("IMAGE", "INT"), which names no variable, so those
 * rows fall back to their own field. A link that runs through reroutes keeps
 * its original origin, so there is no chain to walk.
 */
export function upstreamOutputName(node, index) {
	const link = inputLinkOf(node, index);
	if (!link) return null;
	const resolved = typeof link.resolve === "function" ? link.resolve(node.graph) : null;
	if (!resolved) return null;

	const boundary = resolved.subgraphInput;
	const label = boundary ? boundary.label : resolved.output?.label;
	const authoredName = boundary
		? boundary.name
		: resolved.outputNode?.isSubgraphNode?.() ? resolved.output?.name : null;
	const name = String(label ?? authoredName ?? "").trim();
	return name || null;
}

/**
 * The variable name a rack row publishes. The standard rack follows the output
 * feeding it, so renaming that output renames the variable; the field beside
 * the row shows the name and is read-only while the output supplies one. Rows
 * whose output is not a subgraph output (no authored name) keep their own
 * editable field. The Editable rack always uses the field, and never follows
 * an output - that is where a custom name belongs.
 */
export function rowNameFor(node, index) {
	const typedName = String(node?.widgets?.[index]?.value ?? "").trim();
	if (node?.type !== RACK_TYPE) return typedName;
	return upstreamOutputName(node, index) ?? typedName;
}

/** Row index of `name` on a rack node, or -1. Row i pairs input i with name widget i. */
export function rackRowIndex(node, name) {
	if (!name || !Array.isArray(node.inputs)) return -1;
	for (let index = 0; index < node.inputs.length; index++) {
		if (rowNameFor(node, index) === name) return index;
	}
	return -1;
}

/** The rack row publishing `name` in `graph` or one of its ancestors. */
export function findRackRow(graph, name) {
	if (!name) return null;
	for (const candidate of graphChain(graph)) {
		for (const node of racksIn(candidate)) {
			const index = rackRowIndex(node, name);
			if (index < 0) continue;
			return { node, graph: candidate, index, link: inputLinkOf(node, index) };
		}
	}
	return null;
}

/**
 * The setter publishing `name` in `graph` or one of its ancestors: a KJNodes
 * SetNode or any rack row. This is what a getter rack resolves against.
 */
export function findSetterRow(graph, name) {
	if (!name) return null;
	for (const candidate of graphChain(graph)) {
		for (const node of candidate._nodes ?? []) {
			if (node.type === "SetNode" && String(node.widgets?.[0]?.value ?? "").trim() === name) {
				return { node, graph: candidate, index: 0, link: inputLinkOf(node, 0) };
			}
		}
		const row = findRackRow(candidate, name);
		if (row) return row;
	}
	return null;
}

// Rack lookup runs on every link draw, so the per-graph rack list is cached and
// rebuilt only when the node count changes or a rack edits its rows.
const rackCache = new WeakMap();
const augmentedGetNodeOptions = new WeakSet();

function racksIn(graph) {
	const cached = rackCache.get(graph);
	const count = graph?._nodes?.length ?? 0;
	if (cached && cached.count === count) return cached.racks;
	const racks = (graph?._nodes ?? []).filter((node) => RACK_TYPES.has(node.type));
	rackCache.set(graph, { count, racks });
	return racks;
}

function invalidateRackCache(graph) {
	if (graph) rackCache.delete(graph);
}

/** Whether a setter of this type can feed `filterType`, the same test KJNodes uses. */
function matchesFilterType(setterType, filterType) {
	if (!filterType || filterType === "*" || !setterType || setterType === "*") return true;
	if (typeof LiteGraph.isValidConnection === "function") {
		return LiteGraph.isValidConnection(setterType, filterType);
	}
	return true;
}

/**
 * Every variable visible from `graph`, with the scope it comes from: Set nodes
 * in this graph and its ancestors, plus every rack row. KJNodes' `Get` offers
 * exactly this list, so a rack has to offer it too - a rack that resolved a
 * name it never listed was how a `.parent` variable went missing.
 */
function rackNameSourcesInScope(graph, filterType) {
	const sources = new Map();
	for (const candidate of graphChain(graph)) {
		const local = candidate === graph;
		for (const node of candidate._nodes ?? []) {
			if (node.type !== "SetNode") continue;
			const name = String(node.widgets?.[0]?.value ?? "").trim();
			if (!name || sources.has(name)) continue;
			if (!matchesFilterType(node.inputs?.[0]?.type, filterType)) continue;
			sources.set(name, local ? "local" : "parent");
		}
		for (const rack of racksIn(candidate)) {
			for (let index = 0; index < (rack.inputs?.length ?? 0); index++) {
				const name = rowNameFor(rack, index);
				if (!name || sources.has(name)) continue;
				if (!matchesFilterType(rack.inputs?.[index]?.type, filterType)) continue;
				sources.set(name, local ? "local" : "parent");
			}
		}
	}
	return sources;
}

function rackNamesInScope(graph, filterType) {
	return [...rackNameSourcesInScope(graph, filterType).keys()]
		.sort((left, right) => left.localeCompare(right));
}

/** Type of the input a row's output feeds, for the dropdown's type filter. */
function downstreamFilterType(node, outputIndex) {
	if (app.ui?.settings?.getSettingValue?.("KJNodes.filterGetNodeOptions") === false) {
		return null;
	}
	const linkId = node.outputs?.[outputIndex]?.links?.[0];
	const link = getLink(node.graph, linkId);
	if (!link) return null;
	const target = node.graph?.getNodeById?.(link.target_id);
	return target?.inputs?.[link.target_slot]?.type ?? null;
}

function getNodeFilterType(node) {
	return downstreamFilterType(node, 0);
}

function augmentGetNodeCombo(node) {
	const widget = node.widgets?.find((entry) => entry?.name === "Constant") ?? node.widgets?.[0];
	const options = widget?.options;
	if (!options || augmentedGetNodeOptions.has(options)) return;
	const originalGetter = Object.getOwnPropertyDescriptor(options, "values")?.get;
	if (typeof originalGetter !== "function") return;
	augmentedGetNodeOptions.add(options);
	Object.defineProperty(options, "values", {
		configurable: true,
		enumerable: true,
		get() {
			const existing = originalGetter.call(options) ?? [];
			const rackNames = rackNamesInScope(node.graph, getNodeFilterType(node));
			return [...new Set([...existing, ...rackNames])]
				.sort((left, right) => String(left).localeCompare(String(right)));
		}
	});
}

function installGetNodeAdapter() {
	const proto = LiteGraph.registered_node_types?.GetNode?.prototype;
	if (!proto) return false;
	if (proto.setNodeRackAdapter) return true;

	const originalGetInputLink = proto.getInputLink;
	const originalResolveVirtualOutput = proto.resolveVirtualOutput;
	const originalOnNodeCreated = proto.onNodeCreated;
	if (typeof originalGetInputLink !== "function" &&
		typeof originalResolveVirtualOutput !== "function") {
		return false;
	}
	proto.setNodeRackAdapter = true;

	proto.onNodeCreated = function () {
		originalOnNodeCreated?.apply(this, arguments);
		augmentGetNodeCombo(this);
	};

	if (typeof originalGetInputLink === "function") {
		proto.getInputLink = function (slot) {
			try {
				const row = findRackRow(this.graph, this.widgets?.[0]?.value);
				if (row?.link && row.graph === this.graph) return row.link;
			} catch (error) {
				console.warn("[GetSetRacks] getInputLink lookup failed", error);
			}
			return originalGetInputLink.call(this, slot);
		};
	}

	if (typeof originalResolveVirtualOutput === "function") {
		proto.resolveVirtualOutput = function (slot) {
			try {
				const row = findRackRow(this.graph, this.widgets?.[0]?.value);
				if (row?.link && row.graph !== this.graph) {
					const source = row.graph.getNodeById?.(row.link.origin_id);
					if (source) return { node: source, slot: row.link.origin_slot };
				}
			} catch (error) {
				console.warn("[GetSetRacks] resolveVirtualOutput lookup failed", error);
			}
			return originalResolveVirtualOutput.call(this, slot);
		};
	}

	const root = app.rootGraph ?? app.graph;
	if (root) {
		for (const graph of childGraphs(root)) {
			for (const node of graph?._nodes ?? []) {
				if (node.type === "GetNode") augmentGetNodeCombo(node);
			}
		}
	}
	return true;
}

/**
 * The name field of a standard rack row mirrors the output feeding it, so the
 * node shows what it publishes and a renamed output renames the variable. Rows
 * whose output is not a subgraph output keep the field as their own name.
 */
function syncNamesFromOutputs(node)
{
	if (node.type !== RACK_TYPE) return false;
	let changed = false;
	for (let index = 0; index < (node.inputs?.length ?? 0); index++) {
		const widget = node.widgets?.[index];
		if (!widget) continue;
		const derivedName = upstreamOutputName(node, index);
		if (derivedName && widget.value !== derivedName) {
			widget.value = derivedName;
			changed = true;
		}
		widget.readOnlyName = Boolean(derivedName);
	}
	return changed;
}

/** A followed row's name field is a display, so a click must not open an editor. */
function makeNameWidgetsReadOnly(node)
{
	if (node.type !== RACK_TYPE) return;
	for (const widget of node.widgets ?? []) {
		if (widget.setNodeRackReadOnly) continue;
		widget.setNodeRackReadOnly = true;
		const originalOnClick = widget.onClick;
		widget.onClick = function (options) {
			if (this.readOnlyName) return;
			return originalOnClick?.apply(this, arguments);
		};
	}
}

function installRackPrototype(nodeType) {
	if (nodeType.prototype.__setNodeRack) return;
	nodeType.prototype.__setNodeRack = true;
	nodeType.prototype.isVirtualNode = true;

	// The definition declares one socket and no autogrow, so this extension owns
	// the row list: sockets are added and trimmed here, in lockstep with the name
	// fields. Letting the framework grow sockets made the two get out of step,
	// because it names sockets by position and renders a spare row.
	nodeType.prototype.ensureRows = function (count) {
		const wanted = Math.min(MAX_ROWS, Math.max(1, Math.round(count ?? this.inputs?.length ?? 1)));
		// Node state is not guaranteed to exist yet (creation, partial loads,
		// Nodes 2.0 widget storage), so every row helper stays defensive.
		if (!Array.isArray(this.inputs)) this.inputs = [];
		if (!Array.isArray(this.widgets)) this.widgets = [];
		while (this.inputs.length > wanted) this.removeInput(this.inputs.length - 1);
		while (this.inputs.length < wanted) {
			const before = this.inputs.length;
			this.addInput(`value_${before}`, "*", { shape: OPTIONAL_SLOT_SHAPE });
			if (!Array.isArray(this.inputs) || this.inputs.length <= before) break;
		}
		for (const input of this.inputs) input.shape = OPTIONAL_SLOT_SHAPE;
		this.ensureWidgets(wanted);
		this.syncRows();
	};

	/**
	 * Name widgets have no independent lifecycle in the frontend, so they are
	 * created separately from sockets. This also lets configure prepare widget
	 * storage for positional value restoration before the base configure path
	 * merges the node definition's declared input with the serialized inputs.
	 */
	nodeType.prototype.ensureWidgets = function (count) {
		const wanted = Math.min(MAX_ROWS, Math.max(1, Math.round(count ?? this.widgets?.length ?? 1)));
		if (!Array.isArray(this.widgets)) this.widgets = [];
		while (this.widgets.length > wanted) this.widgets.pop();
		while (this.widgets.length < wanted) {
			const before = this.widgets.length;
			this.addWidget("text", `name_${before}`, "", null, {});
			if (!Array.isArray(this.widgets) || this.widgets.length <= before) break;
		}
		makeNameWidgetsReadOnly(this);
	};

	/** True when the socket at `index` has a link, without deprecated reads. */
	nodeType.prototype.rowConnected = function (index) {
		if (typeof this.isInputConnected === "function") return this.isInputConnected(index);
		return this.inputs?.[index]?.link != null;
	};

	nodeType.prototype.addRow = function () {
		this.ensureRows((this.inputs?.length ?? 0) + 1);
	};

	nodeType.prototype.rowIsBlank = function (index) {
		return !this.rowConnected(index) && rowNameFor(this, index) === "";
	};

	nodeType.prototype.realRowCount = function () {
		let last = 0;
		for (let index = 0; index < (this.inputs?.length ?? 0); index++) {
			if (!this.rowIsBlank(index)) last = index + 1;
		}
		return Math.max(1, last);
	};

	/** Keep one blank row available for the next link without serializing it. */
	nodeType.prototype.ensureSpareRow = function () {
		const realRows = this.realRowCount();
		this.ensureRows(Math.min(MAX_ROWS, realRows + (realRows < MAX_ROWS ? 1 : 0)));
	};

	nodeType.prototype.syncRows = function () {
		invalidateRackCache(this.graph);
		const changed = syncNamesFromOutputs(this);
		// The title belongs to the workflow or the user; it is defaulted once and
		// never rewritten with a row count.
		if (!this.title) this.title = ROW_TITLE_PREFIX;
		if (changed) this.setDirtyCanvas?.(true, true);
		return changed;
	};

	/**
	 * A renamed subgraph output announces itself on the graph holding the
	 * instance, which is this rack's graph, so the row follows immediately
	 * instead of waiting for its next draw.
	 */
	nodeType.prototype.bindGraphEvents = function () {
		const events = this.graph?.events;
		if (!events?.addEventListener || this.graphEventsBound) return;
		this.graphEventsBound = true;
		events.addEventListener("node:slot-label:changed", () => this.syncRows());
		events.addEventListener("node:slot-links:changed", () => this.syncRows());
	};

	nodeType.prototype.rowIndexFor = function (name) {
		return rackRowIndex(this, name);
	};

	const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
	nodeType.prototype.onNodeCreated = function () {
		originalOnNodeCreated?.apply(this, arguments);
		this.color = "#222";
		this.bgcolor = "#000";
		this.ensureRows(1);
		this.bindGraphEvents();
	};

	const originalOnAdded = nodeType.prototype.onAdded;
	nodeType.prototype.onAdded = function () {
		const result = originalOnAdded?.apply(this, arguments);
		this.bindGraphEvents();
		this.syncRows();
		return result;
	};

	const originalConfigure = nodeType.prototype.configure;
	nodeType.prototype.configure = function (info) {
		// ComfyNode.configure keeps the definition's declared input and appends
		// serialized inputs with other names. Normalize the serialized list first
		// so the declared value_0 matches row zero instead of becoming a phantom.
		if (Array.isArray(info?.inputs)) {
			for (let index = 0; index < info.inputs.length; index++) {
				const name = `value_${index}`;
				info.inputs[index].name = name;
				info.inputs[index].localized_name = name;
			}
		}
		// Widget values are restored positionally, so prepare only the matching
		// name fields. Socket restoration remains owned by configure itself.
		const rows = Math.max(info?.inputs?.length ?? 0, info?.widgets_values?.length ?? 0, 1);
		this.ensureWidgets(rows);
		originalConfigure?.apply(this, arguments);
		this.ensureSpareRow();
	};

	const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
	nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, isConnected, linkInfo) {
		originalConnectionsChange?.apply(this, arguments);
		// Restored links emit this callback again after configure while the graph
		// is still loading. They are not user gestures and must not add rows.
		if (graphIsLoading()) return;
		if (slotIndex == null || !this.inputs?.[slotIndex]) return;
		const input = this.inputs[slotIndex];
		if (isConnected && linkInfo) {
			const resolved = linkInfo.resolve?.(this.graph);
			const type = resolved?.output?.type ?? resolved?.subgraphInput?.type;
			if (type) input.type = type;
			this.ensureSpareRow();
		} else {
			input.type = "*";
			this.ensureSpareRow();
		}
	};

	const originalWidgetChanged = nodeType.prototype.onWidgetChanged;
	nodeType.prototype.onWidgetChanged = function (name, value, oldValue, widget) {
		originalWidgetChanged?.apply(this, arguments);
		this.ensureSpareRow();
	};

	const originalOnSerialize = nodeType.prototype.onSerialize;
	nodeType.prototype.onSerialize = function (serialized) {
		// The trailing spare is UI-only. Commit real rows and let configure
		// recreate the spare on the next load.
		let rowCount = serialized?.inputs?.length ?? 0;
		while (rowCount > 1 && this.rowIsBlank(rowCount - 1)) {
			serialized.inputs.pop();
			serialized.widgets_values?.pop();
			if (serialized.widgets_values_named) {
				delete serialized.widgets_values_named[`name_${rowCount - 1}`];
			}
			rowCount--;
		}
		originalOnSerialize?.apply(this, arguments);
	};

	const originalDraw = nodeType.prototype.onDrawForeground;
	nodeType.prototype.onDrawForeground = function (ctx) {
		if (!graphIsLoading()) {
			if ((this.inputs?.length ?? 0) !== (this.widgets?.length ?? 0) ||
				!this.rowIsBlank((this.inputs?.length ?? 1) - 1)) {
				this.ensureSpareRow();
			} else {
				// Cheap check: writes and redraws only when a row's name moved.
				this.syncRows();
			}
		}
		originalDraw?.apply(this, arguments);
	};

	const originalMenuOptions = nodeType.prototype.getExtraMenuOptions;
	nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
		originalMenuOptions?.apply(this, arguments);
		options.unshift(
			{ content: "Add row", callback: () => this.addRow() },
			{ content: "Remove unused rows", callback: () => this.ensureSpareRow() }
		);
	};
}

function installGetRackPrototype(nodeType) {
	if (nodeType.prototype.__getNodeRack) return;
	nodeType.prototype.__getNodeRack = true;
	nodeType.prototype.isVirtualNode = true;
	// The outputs resolve through their setters, so the node draws no links of
	// its own - the same contract KJNodes' GetNode declares.
	nodeType.prototype.drawConnection = false;

	nodeType.prototype.ensureRows = function (count) {
		const wanted = Math.min(MAX_ROWS, Math.max(1, Math.round(count ?? this.outputs?.length ?? 1)));
		if (!Array.isArray(this.outputs)) this.outputs = [];
		if (!Array.isArray(this.widgets)) this.widgets = [];
		while (this.outputs.length > wanted) this.removeOutput(this.outputs.length - 1);
		while (this.outputs.length < wanted) {
			const before = this.outputs.length;
			this.addOutput(`get_${before}`, "*");
			if (!Array.isArray(this.outputs) || this.outputs.length <= before) break;
		}
		this.ensureWidgets(wanted);
		this.syncRows();
	};

	/** One name chooser per row, listing the variables visible from this graph. */
	nodeType.prototype.ensureWidgets = function (count) {
		const wanted = Math.min(MAX_ROWS, Math.max(1, Math.round(count ?? this.widgets?.length ?? 1)));
		if (!Array.isArray(this.widgets)) this.widgets = [];
		while (this.widgets.length > wanted) this.widgets.pop();
		while (this.widgets.length < wanted) {
			const before = this.widgets.length;
			// The label needs the scope a name came from; KJNodes marks names that
			// live in an ancestor graph, and the values getter fills this per row.
			const rowScope = { sources: new Map() };
			const widget = this.addWidget("combo", `name_${before}`, "", null, {
				values: [],
				getOptionLabel: (value) =>
				{
					if (is_unused_row_value(value)) return UNUSED_ROW_LABEL;
					const text = String(value);
					return rowScope.sources.get(text) === "parent" ? `${text} (parent)` : text;
				},
			});
			if (!Array.isArray(this.widgets) || this.widgets.length <= before) break;
			// The list is live: it follows the setters in scope, filtered by the
			// type the row's output feeds, exactly like KJNodes' GetNode chooser.
			Object.defineProperty(widget.options, "values", {
				configurable: true,
				enumerable: true,
				get: () => {
					const index = this.widgets?.indexOf(widget) ?? -1;
					if (index < 0)
					{
						rowScope.sources = new Map();
						return [];
					}
					rowScope.sources = rackNameSourcesInScope(this.graph, downstreamFilterType(this, index));
					return [UNUSED_ROW_LABEL, ...[...rowScope.sources.keys()].sort((left, right) => left.localeCompare(right))];
				}
			});
		}
	};

	nodeType.prototype.rowName = function (index) {
		const value = String(this.widgets?.[index]?.value ?? "").trim();
		return is_unused_row_value(value) ? "" : value;
	};

	nodeType.prototype.rowIndexFor = function (name) {
		if (!name) return -1;
		for (let index = 0; index < (this.outputs?.length ?? 0); index++) {
			if (this.rowName(index) === name) return index;
		}
		return -1;
	};

	/** Point a row's output at the setter it reads, or back to a blank socket. */
	nodeType.prototype.applyRowName = function (index, value) {
		const output = this.outputs?.[index];
		if (!output) return;
		const row = findSetterRow(this.graph, value);
		output.name = value || `get_${index}`;
		output.label = value || null;
		output.type = row?.node?.inputs?.[row.index]?.type ?? "*";
		this.setDirtyCanvas?.(true, true);
	};

	/**
	 * Retire a row. The frontend's own removeOutput drops that row's links and
	 * renumbers every later output, so the consumers below keep reading their
	 * variable; the widget values shift with them and the spare row returns.
	 */
	nodeType.prototype.clearRow = function (index) {
		if (this.getNodeRackClearing || index < 0 || index >= (this.outputs?.length ?? 0)) return;
		this.getNodeRackClearing = true;
		try {
			if (index < this.outputs.length - 1) {
				this.removeOutput(index);
				for (let i = index; i + 1 < (this.widgets?.length ?? 0); i++) {
					this.widgets[i].value = this.widgets[i + 1].value;
				}
				this.widgets.pop();
			} else {
				// The last row is the spare: drop what it fed and leave it blank.
				this.disconnectOutput?.(index);
			}

			this.ensureSpareRow();
			for (let i = 0; i < (this.outputs?.length ?? 0); i++) {
				this.applyRowName(i, this.rowName(i));
			}
		}
		finally {
			this.getNodeRackClearing = false;
		}
	};

	nodeType.prototype.ensureSpareRow = function () {
		let last = 0;
		for (let index = 0; index < (this.outputs?.length ?? 0); index++) {
			if (this.rowName(index) !== "") last = index + 1;
		}
		const rows = Math.max(1, last) + (last < MAX_ROWS ? 1 : 0);
		this.ensureRows(Math.min(MAX_ROWS, rows));
	};

	nodeType.prototype.syncRows = function () {
		for (let index = 0; index < (this.outputs?.length ?? 0); index++) {
			this.applyRowName(index, this.rowName(index));
		}
		if (!this.title) this.title = GET_ROW_TITLE_PREFIX;
		this.setDirtyCanvas?.(true, true);
	};

	/**
	 * The setter's own input link, when the setter lives in this graph. The
	 * subgraph expander calls this to read a virtual node's output.
	 */
	nodeType.prototype.getInputLink = function (slot) {
		const row = findSetterRow(this.graph, this.rowName(slot));
		return row?.link && row.graph === this.graph ? row.link : null;
	};

	/** The same lookup for a setter that lives in an ancestor graph. */
	nodeType.prototype.resolveVirtualOutput = function (slot) {
		const row = findSetterRow(this.graph, this.rowName(slot));
		if (!row?.link || row.graph === this.graph) return null;
		const source = row.graph.getNodeById?.(row.link.origin_id);
		return source ? { node: source, slot: row.link.origin_slot } : null;
	};

	const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
	nodeType.prototype.onNodeCreated = function () {
		originalOnNodeCreated?.apply(this, arguments);
		this.color = "#222";
		this.bgcolor = "#000";
		this.ensureRows(1);
	};

	const originalConfigure = nodeType.prototype.configure;
	nodeType.prototype.configure = function (info) {
		// Row sockets are positional, exactly like the setter rack's: rename the
		// serialized list so the declared get_0 lines up with row zero.
		if (Array.isArray(info?.outputs)) {
			for (let index = 0; index < info.outputs.length; index++) {
				info.outputs[index].name = `get_${index}`;
				info.outputs[index].localized_name = `get_${index}`;
			}
		}
		const rows = Math.max(info?.outputs?.length ?? 0, info?.widgets_values?.length ?? 0, 1);
		this.ensureWidgets(rows);
		originalConfigure?.apply(this, arguments);
		this.ensureSpareRow();
	};

	const originalWidgetChanged = nodeType.prototype.onWidgetChanged;
	nodeType.prototype.onWidgetChanged = function (name, value, oldValue, widget) {
		originalWidgetChanged?.apply(this, arguments);
		if (graphIsLoading()) return;
		const index = this.widgets?.indexOf(widget) ?? -1;
		if (index < 0) return;
		if (is_unused_row_value(value)) {
			this.clearRow(index);
			return;
		}
		this.applyRowName(index, this.rowName(index));
		this.ensureSpareRow();
	};

	const originalOnSerialize = nodeType.prototype.onSerialize;
	nodeType.prototype.onSerialize = function (serialized) {
		let rowCount = serialized?.outputs?.length ?? 0;
		while (rowCount > 1 && this.rowName(rowCount - 1) === "") {
			serialized.outputs.pop();
			serialized.widgets_values?.pop();
			rowCount--;
		}
		originalOnSerialize?.apply(this, arguments);
	};

	const originalDraw = nodeType.prototype.onDrawForeground;
	nodeType.prototype.onDrawForeground = function (ctx) {
		if (!graphIsLoading() &&
			((this.outputs?.length ?? 0) !== (this.widgets?.length ?? 0) ||
				this.rowName((this.outputs?.length ?? 1) - 1) !== "")) {
			this.ensureSpareRow();
		}
		originalDraw?.apply(this, arguments);
	};

	const originalMenuOptions = nodeType.prototype.getExtraMenuOptions;
	nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
		originalMenuOptions?.apply(this, arguments);
		options.unshift(
			{ content: "Add row", callback: () => this.ensureRows((this.outputs?.length ?? 0) + 1) },
			{ content: "Remove unused rows", callback: () => this.ensureSpareRow() }
		);
	};
}

/**
 * Replace a column of Get nodes with one rack, keeping every consumer on the
 * value it already reads.
 *
 * Rows are filled in reading order (top to bottom, then left to right) and each
 * Get's output links are moved onto its row before the Get is removed, so the
 * prompt the frontend builds is unchanged: both resolve the same setter.
 */
export function convertGetNodesToRack(graph, getNodes)
{
	if (!graph || (getNodes?.length ?? 0) < 2)
	{
		return null;
	}

	const ordered = [...getNodes].sort((left, right) =>
		(left.pos[1] - right.pos[1]) || (left.pos[0] - right.pos[0]));
	const rack = LiteGraph.createNode(GET_RACK_TYPE);
	if (!rack)
	{
		console.warn("[GetSetRacks] GetNodeRack is not registered; cannot convert Get nodes.");
		return null;
	}

	graph.beforeChange?.();
	try
	{
		rack.pos = [ordered[0].pos[0], ordered[0].pos[1]];
		graph.add(rack);
		rack.ensureRows(ordered.length + 1);

		for (let index = 0; index < ordered.length; index++)
		{
			const get = ordered[index];
			const name = String(get.widgets?.[0]?.value ?? "").trim();
			const kind = get.outputs?.[0]?.type;
			rack.widgets[index].value = name;
			if (kind)
			{
				rack.outputs[index].type = kind;
			}
			rack.applyRowName(index, name);

			for (const linkId of [...(get.outputs?.[0]?.links ?? [])])
			{
				const link = graph.getLink?.(linkId);
				if (!link)
				{
					continue;
				}
				link.origin_id = rack.id;
				link.origin_slot = index;
				rack.outputs[index].links.push(linkId);
			}
		}

		for (const get of ordered)
		{
			graph.remove(get);
		}

		rack.ensureSpareRow();
		rack.syncRows();
	}
	finally
	{
		graph.afterChange?.();
	}

	app.canvas?.deselectAllNodes?.();
	app.canvas?.selectNode?.(rack, false);
	graph.setDirtyCanvas?.(true, true);
	return rack;
}

/** The Get nodes the current selection would fold, plus an explicitly clicked one. */
function selectedGetNodes(graph, extraNode = null)
{
	const gets = new Set();
	for (const item of (app.canvas?.selectedItems ?? []))
	{
		if (item?.type === "GetNode" && item.graph === graph)
		{
			gets.add(item);
		}
	}
	if (extraNode?.type === "GetNode" && extraNode.graph === graph)
	{
		gets.add(extraNode);
	}
	return [...gets];
}

function getRackConversionItem(graph)
{
	const gets = selectedGetNodes(graph);
	if (gets.length < 2)
	{
		return null;
	}

	return {
		content: `Convert ${gets.length} Get nodes to GetNode Rack`,
		callback: () => convertGetNodesToRack(graph, gets),
	};
}

app.registerExtension({
	name: "Sparknight.GetSetRacks",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (RACK_TYPES.has(nodeData?.name)) installRackPrototype(nodeType);
		if (nodeData?.name === GET_RACK_TYPE) installGetRackPrototype(nodeType);
	},

	/** Selecting several Get nodes offers to fold them into one rack. */
	getCanvasMenuItems(canvas)
	{
		const item = getRackConversionItem(canvas?.graph);
		return item ? [null, item] : [];
	},

	/** Right-clicking one of those Get nodes offers the same conversion. */
	getNodeMenuItems(node)
	{
		const item = node?.type === "GetNode" ? getRackConversionItem(node.graph) : null;
		return item ? [item] : [];
	},

	// Node definitions are registered before extension hooks run when a type is
	// defined by an already-loaded pack, and the GetNode type may be registered
	// after this extension loads, so both are retried here and on registration.
	setup() {
		for (const rackType of RACK_TYPES) {
			const registered = LiteGraph.registered_node_types?.[rackType];
			if (registered) installRackPrototype(registered);
		}
		const getRackType = LiteGraph.registered_node_types?.[GET_RACK_TYPE];
		if (getRackType) installGetRackPrototype(getRackType);
		installGetNodeAdapter();
		LiteGraph.onNodeTypeRegistered = ((original) => (type, baseClass) => {
			original?.(type, baseClass);
			if (type === "GetNode") installGetNodeAdapter();
		})(LiteGraph.onNodeTypeRegistered);
	},

	async afterConfigureGraph() {
		if (!installGetNodeAdapter()) {
			console.warn("[GetSetRacks] KJNodes GetNode not found; rack variables will not resolve.");
		}
	}
});
