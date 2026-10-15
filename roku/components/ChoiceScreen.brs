' A plain list to choose from: profiles, servers.
sub init()
  m.list = m.top.findNode("list")
  m.list.observeField("itemSelected", "onSelected")
end sub

sub onParams()
  p = m.top.params
  m.top.findNode("title").text = p.title
  m.items = p.items
  root = CreateObject("roSGNode", "ContentNode")
  for each item in p.items
    node = root.createChild("ContentNode")
    node.title = item.label
    if item.note <> "" then node.title = item.label + "   (" + item.note + ")"
  end for
  m.list.content = root
end sub

sub activate()
  m.list.setFocus(true)
end sub

sub onSelected()
  item = m.items[m.list.itemSelected]
  m.top.route = { name: "chosen", kind: m.top.params.kind, id: item.id }
end sub
