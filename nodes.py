"""Backend definitions for the rack nodes.

The nodes are driven entirely by the frontend extension: they publish named
variables, or read them back, and are stripped from the prompt before execution.
These stubs exist so each node has a real definition (node library, workflow
validation, API workflows) instead of being a frontend-only type.
"""

from comfy_api.latest import io


# The frontend extension names row sockets value_0 .. value_(MAX_ROWS - 1) for
# the setter racks and get_0 .. get_(MAX_ROWS - 1) for the getter rack.
MAX_ROWS = 99
SET_ROW_TOOLTIP = "Row value. The row's variable name comes from this row's stream."


def _not_executable():
	raise RuntimeError(
		"Racks publish and read variables in the frontend and must not be "
		"executed; the ComfyUI-GetSetRacks web extension is not loaded."
	)


class SetNodeRack(io.ComfyNode):
	@classmethod
	def define_schema(cls):
		# Deliberately *not* an autogrow input: the web extension owns the socket
		# list so it can keep exactly one name field per socket, holding the
		# derived label or the typed name. The framework's autogrow forces its
		# template into a socket, renames sockets positionally, and renders a
		# spare row, so it cannot carry per-row name fields.
		return io.Schema(
			node_id="SetNodeRack",
			display_name="SetNode Rack",
			category="Sparknight/variables",
			description=(
				"Publishes several named variables from one node. A row is named after "
				"the output feeding it and keeps any name you type over it, so the "
				f"same name is never typed twice. Up to {MAX_ROWS} rows."
			),
			inputs=[
				io.AnyType.Input(
					"value_0",
					optional=True,
					tooltip=SET_ROW_TOOLTIP,
				)
			],
			outputs=[],
		)

	@classmethod
	def execute(cls, value_0=None):
		_not_executable()


class SetNodeRackNamed(io.ComfyNode):
	@classmethod
	def define_schema(cls):
		return io.Schema(
			node_id="SetNodeRackNamed",
			display_name="SetNode Rack (Editable)",
			category="Sparknight/variables",
			description=(
				"Publishes several named variables from one node, each named only by "
				"its own text field. Use it when the input's name is not the variable "
				f"name. Up to {MAX_ROWS} rows."
			),
			inputs=[
				io.AnyType.Input(
					"value_0",
					optional=True,
					tooltip="Row value. Name the row in the field beside it.",
				)
			],
			outputs=[],
		)

	@classmethod
	def execute(cls, value_0=None):
		_not_executable()


class GetNodeRack(io.ComfyNode):
	@classmethod
	def define_schema(cls):
		return io.Schema(
			node_id="GetNodeRack",
			display_name="GetNode Rack",
			category="Sparknight/variables",
			description=(
				"Reads several named variables from one node. Each row picks a name "
				"published by a Set node or rack in scope and outputs its value. "
				f"Up to {MAX_ROWS} rows."
			),
			inputs=[],
			outputs=[
				io.AnyType.Output(
					"get_0",
					tooltip="Row value. Pick the variable to read in the field beside it.",
				)
			],
		)

	@classmethod
	def execute(cls):
		_not_executable()


NODE_CLASS_MAPPINGS = {
	"SetNodeRack": SetNodeRack,
	"SetNodeRackNamed": SetNodeRackNamed,
	"GetNodeRack": GetNodeRack,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	"SetNodeRack": "SetNode Rack",
	"SetNodeRackNamed": "SetNode Rack (Editable)",
	"GetNodeRack": "GetNode Rack",
}
