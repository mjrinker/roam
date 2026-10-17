' Labels: with no label chosen, this profile's labels with how many titles each has; with one, the movies and shows under it.
sub init()
  m.list = m.top.findNode("list")
  m.list.observeField("itemSelected", "onSelected")
  m.actions = []
end sub

sub activate()
  if m.started = true then
    m.list.setFocus(true)
    return
  end if
  m.started = true
  p = m.top.params
  base = "/api/v1/servers/" + p.serverId + "/labels"
  if p.labelId = invalid then
    m.top.findNode("title").text = "Labels"
    apiCall("GET", base, invalid, "onLabels")
  else
    m.top.findNode("title").text = p.name
    apiCall("GET", base + "/" + p.labelId, invalid, "onItems")
  end if
end sub

sub say(text as String)
  status = m.top.findNode("status")
  status.text = text
  status.visible = text <> ""
end sub

sub onLabels(event as Object)
  r = event.getData()
  if r.status <> 200 or r.json = invalid then
    say("Couldn't load your labels. Press Back, then try again.")
    return
  end if
  if r.json.labels.Count() = 0 then
    say("No labels yet. Make one on the web or in the Android app.")
    return
  end if
  actions = []
  for each l in r.json.labels
    actions.push({ label: l.name + "   (" + Stri(l.count).Trim() + ")", kind: "open", id: l.id, name: l.name })
  end for
  show(actions)
end sub

sub onItems(event as Object)
  r = event.getData()
  if r.status <> 200 or r.json = invalid then
    say("Couldn't load this label. Press Back, then try again.")
    return
  end if
  actions = []
  for each e in r.json.items
    if e.type = "movie" or e.type = "show" then
      label = e.name
      if e.subtitle <> invalid and e.subtitle <> "" then label = label + "   (" + e.subtitle + ")"
      actions.push({ label: label, kind: "title", id: e.id, type: e.type })
    end if
  end for
  if actions.Count() = 0 then
    say("Nothing under this label that a Roku can play.")
    return
  end if
  show(actions)
end sub

sub show(actions as Object)
  m.actions = actions
  content = CreateObject("roSGNode", "ContentNode")
  for each a in actions
    node = content.createChild("ContentNode")
    node.title = a.label
  end for
  say("")
  m.list.content = content
  m.list.visible = true
  m.list.setFocus(true)
end sub

sub onSelected()
  a = m.actions[m.list.itemSelected]
  p = m.top.params
  if a.kind = "open" then
    m.top.route = { name: "label", serverId: p.serverId, labelId: a.id, title: a.name }
  else
    m.top.route = { name: "detail", serverId: p.serverId, type: a.type, id: a.id }
  end if
end sub
