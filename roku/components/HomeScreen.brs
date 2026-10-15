sub init()
  m.tasks = {}
  m.rows = m.top.findNode("rows")
  m.rows.observeField("rowItemSelected", "onSelected")
end sub

sub activate()
  if m.loaded = true then
    m.rows.setFocus(true)
    return
  end if
  m.tasks.home = apiCall("GET", "/api/v1/servers/" + m.top.params.serverId + "/home", invalid, "onHome")
end sub

' Libraries Roku can open today: lists of movies and shows, and folders of videos.
function usableLibrary(lib as Object) as Boolean
  if lib.style = "grid" then return lib.kind = "movies" or lib.kind = "shows"
  if lib.style = "folders" then return lib.kind = "video"
  return false
end function

sub onHome(event as Object)
  r = event.getData()
  status = m.top.findNode("status")
  if r.status <> 200 or r.json = invalid then
    status.text = "Couldn't load Roam. Press Back, then try again."
    return
  end if
  h = r.json
  m.serverId = m.top.params.serverId
  root = CreateObject("roSGNode", "ContentNode")
  addRow(root, "Continue watching", h.continueWatching)
  addRow(root, "Recently added", h.recentlyAdded)
  libs = root.createChild("ContentNode")
  libs.title = "Libraries"
  for each lib in h.libraries
    if usableLibrary(lib) then
      node = libs.createChild("ContentNode")
      node.title = lib.name
      node.shortDescriptionLine1 = lib.name
      node.addFields({ itemType: "library", itemId: lib.id, style: lib.style })
    end if
  end for
  tools = root.createChild("ContentNode")
  tools.title = "More"
  for each t in [{ id: "search", name: "Search" }, { id: "profile", name: "Switch profile" }, { id: "signout", name: "Sign out" }]
    node = tools.createChild("ContentNode")
    node.title = t.name
    node.shortDescriptionLine1 = t.name
    node.addFields({ itemType: "action", itemId: t.id })
  end for
  m.top.findNode("title").text = h.server.name
  status.visible = false
  m.rows.content = root
  m.rows.visible = true
  m.rows.setFocus(true)
  m.loaded = true
end sub

sub addRow(root as Object, title as String, items as Dynamic)
  if items = invalid or items.Count() = 0 then return
  row = root.createChild("ContentNode")
  row.title = title
  for each item in items
    if item.type = "movie" or item.type = "show" or item.type = "episode" then row.appendChild(itemNode(item))
  end for
end sub

sub onSelected()
  where = m.rows.rowItemSelected
  row = m.rows.content.getChild(where[0])
  item = row.getChild(where[1])
  t = item.itemType
  if t = "library" then
    m.top.route = { name: "browse", serverId: m.serverId, libraryId: item.itemId, title: item.title, style: item.style }
  else if t = "action" then
    if item.itemId = "search" then m.top.route = { name: "search", serverId: m.serverId }
    if item.itemId = "profile" then m.top.route = { name: "switchProfile" }
    if item.itemId = "signout" then m.top.route = { name: "signOut" }
  else if t = "episode" then
    m.top.route = { name: "play", params: { serverId: m.serverId, kind: "episode", id: item.itemId, name: item.title } }
  else
    m.top.route = { name: "detail", serverId: m.serverId, type: t, id: item.itemId }
  end if
end sub
