' A library: a grid of movies or shows (a page at a time), or the folders and videos of a video library.
sub init()
  m.tasks = {}
  m.grid = m.top.findNode("grid")
  m.grid.observeField("itemSelected", "onSelected")
  m.grid.observeField("itemFocused", "onFocused")
  m.items = []
  m.page = 0
  m.hasMore = true
  m.loading = false
  m.path = ""
end sub

sub activate()
  if m.started = true then
    m.grid.setFocus(true)
    return
  end if
  m.started = true
  m.top.findNode("title").text = m.top.params.name
  m.content = CreateObject("roSGNode", "ContentNode")
  loadMore()
end sub

sub loadMore()
  if m.loading or not m.hasMore then return
  m.loading = true
  base = "/api/v1/servers/" + m.top.params.serverId + "/libraries/" + m.top.params.libraryId + "/items"
  if m.top.params.style = "grid" then
    m.page = m.page + 1
    path = base + "?page=" + Stri(m.page).Trim()
  else
    path = base + "?path=" + m.path.EncodeUriComponent()
    if m.after <> invalid then path = path + "&after=" + m.after.EncodeUriComponent()
  end if
  m.tasks.items = apiCall("GET", path, invalid, "onItems")
end sub

sub onItems(event as Object)
  r = event.getData()
  m.loading = false
  status = m.top.findNode("status")
  if r.status <> 200 or r.json = invalid then
    status.text = "Couldn't load this library. Press Back, then try again."
    status.visible = true
    return
  end if
  j = r.json
  if m.top.params.style = "grid" then
    m.hasMore = j.hasMore = true
  else
    m.after = j.next
    m.hasMore = j.next <> invalid
    if m.addFolders = invalid or m.after = invalid then addFolders(j.folders)
  end if
  for each item in j.items
    m.content.appendChild(itemNode(item))
  end for
  if m.content.getChildCount() = 0 then
    status.text = "Nothing here yet."
    status.visible = true
    return
  end if
  status.visible = false
  m.grid.content = m.content
  m.grid.visible = true
  m.grid.setFocus(true)
end sub

sub addFolders(folders as Dynamic)
  m.addFolders = true
  if folders = invalid then return
  for each name in folders
    node = CreateObject("roSGNode", "ContentNode")
    node.title = name
    node.shortDescriptionLine1 = name
    node.shortDescriptionLine2 = "Folder"
    node.addFields({ itemType: "folder", itemId: name })
    m.content.appendChild(node)
  end for
end sub

' More arrives as the focus nears the end.
sub onFocused()
  total = m.content.getChildCount()
  if total > 0 and m.grid.itemFocused >= total - 12 then loadMore()
end sub

sub onSelected()
  item = m.content.getChild(m.grid.itemSelected)
  if item.itemType = "folder" then
    ' Open a folder in place: start the listing over one level down.
    if m.path = "" then m.path = item.itemId else m.path = m.path + "/" + item.itemId
    m.content = CreateObject("roSGNode", "ContentNode")
    m.after = invalid
    m.addFolders = invalid
    m.hasMore = true
    m.top.findNode("title").text = item.itemId
    loadMore()
  else
    m.top.route = { name: "detail", serverId: m.top.params.serverId, type: item.itemType, id: item.itemId }
  end if
end sub
