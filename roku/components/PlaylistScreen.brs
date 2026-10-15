' Playlists: with no playlist chosen, the ones this profile can see; with one, its movies, shows and episodes. Only what a Roku can play is
' listed (a playlist's audiobooks and photos are left out here). An episode plays at once with the episodes after it queued.
sub init()
  m.tasks = {}
  m.list = m.top.findNode("list")
  m.list.observeField("itemSelected", "onSelected")
  m.actions = []
  m.entries = []
  m.next = invalid
end sub

sub activate()
  if m.started = true then
    m.list.setFocus(true)
    return
  end if
  m.started = true
  p = m.top.params
  base = "/api/v1/servers/" + p.serverId + "/playlists"
  if p.playlistId = invalid then
    m.top.findNode("title").text = "Playlists"
    m.tasks.lists = apiCall("GET", base, invalid, "onLists")
  else
    m.top.findNode("title").text = p.name
    loadItems()
  end if
end sub

sub say(text as String)
  status = m.top.findNode("status")
  status.text = text
  status.visible = text <> ""
end sub

sub onLists(event as Object)
  r = event.getData()
  if r.status <> 200 or r.json = invalid then
    say("Couldn't load your playlists. Press Back, then try again.")
    return
  end if
  lists = r.json.playlists
  if lists.Count() = 0 then
    say("No playlists yet. Make one on the web or in another app.")
    return
  end if
  actions = []
  for each l in lists
    count = "items"
    if l.itemCount = 1 then count = "item"
    label = l.name + "   (" + Stri(l.itemCount).Trim() + " " + count
    if l.ownerName <> invalid and l.ownerName <> "" then label = label + " · " + l.ownerName
    actions.push({ label: label + ")", kind: "open", id: l.id, name: l.name })
  end for
  show(actions)
end sub

sub loadItems()
  p = m.top.params
  path = "/api/v1/servers/" + p.serverId + "/playlists/" + p.playlistId
  if m.next <> invalid then path = path + "?after=" + m.next.EncodeUriComponent()
  m.tasks.items = apiCall("GET", path, invalid, "onItems")
end sub

' Whether a Roku can open this entry.
function usable(e as Object) as Boolean
  if e.playable = false then return false
  return e.type = "movie" or e.type = "show" or e.type = "episode"
end function

sub onItems(event as Object)
  r = event.getData()
  if r.status <> 200 or r.json = invalid then
    say("Couldn't load this playlist. Press Back, then try again.")
    return
  end if
  for each e in r.json.items
    if usable(e) then m.entries.push(e)
  end for
  m.next = r.json.next
  if m.entries.Count() = 0 and m.next = invalid then
    say("Nothing here that a Roku can play.")
    return
  end if
  actions = []
  if m.entries.Count() > 0 then actions.push({ label: "Play", kind: "entry", index: 0 })
  for i = 0 to m.entries.Count() - 1
    e = m.entries[i]
    label = e.name
    if e.subtitle <> invalid and e.subtitle <> "" then label = label + "   (" + e.subtitle + ")"
    actions.push({ label: label, kind: "entry", index: i })
  end for
  if m.next <> invalid then actions.push({ label: "Show more", kind: "more" })
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
    m.top.route = { name: "playlist", serverId: p.serverId, playlistId: a.id, title: a.name }
  else if a.kind = "more" then
    say("Loading...")
    m.list.visible = false
    loadItems()
  else if a.kind = "entry" then
    openEntry(a.index)
  end if
end sub

sub openEntry(index as Integer)
  p = m.top.params
  e = m.entries[index]
  if e.type = "episode" then
    ' The episodes straight after this one (up to the first thing that isn't an episode) play on by themselves.
    rest = []
    for i = index + 1 to m.entries.Count() - 1
      if m.entries[i].type <> "episode" then exit for
      rest.push(m.entries[i].id)
    end for
    m.top.route = { name: "play", params: { serverId: p.serverId, kind: "episode", id: e.id, name: e.name, queue: rest } }
  else
    m.top.route = { name: "detail", serverId: p.serverId, type: e.type, id: e.id }
  end if
end sub
