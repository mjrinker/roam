sub init()
  m.tasks = {}
  m.keyboard = m.top.findNode("keyboard")
  m.results = m.top.findNode("results")
  m.timer = m.top.findNode("debounce")
  m.keyboard.observeField("text", "onText")
  m.timer.observeField("fire", "onSearch")
  m.results.observeField("itemSelected", "onSelected")
  m.hits = []
end sub

sub activate()
  m.keyboard.setFocus(true)
end sub

sub onText()
  m.timer.control = "stop"
  m.timer.control = "start"
end sub

sub onSearch()
  q = m.keyboard.text
  if Len(q) < 2 then return
  m.tasks.search = apiCall("GET", "/api/v1/servers/" + m.top.params.serverId + "/search?q=" + q.EncodeUriComponent(), invalid, "onResults")
end sub

sub onResults(event as Object)
  r = event.getData()
  status = m.top.findNode("status")
  if r.status <> 200 or r.json = invalid then
    status.text = "Couldn't search. Try again."
    return
  end if
  content = CreateObject("roSGNode", "ContentNode")
  m.hits = []
  for each item in r.json.items
    ' Movies and shows open here; books, music and albums need other screens.
    if item.type = "movie" or item.type = "show" then
      content.appendChild(itemNode(item))
      m.hits.push(item)
    end if
  end for
  if m.hits.Count() = 0 then
    status.text = "Nothing found."
    status.visible = true
    m.results.visible = false
    return
  end if
  status.visible = false
  m.results.content = content
  m.results.visible = true
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
  if not press then return false
  if key = "right" and m.keyboard.hasFocus() and m.results.visible then
    m.results.setFocus(true)
    return true
  end if
  if key = "left" and m.results.hasFocus() then
    m.keyboard.setFocus(true)
    return true
  end if
  return false
end function

sub onSelected()
  item = m.hits[m.results.itemSelected]
  m.top.route = { name: "detail", serverId: m.top.params.serverId, type: item.type, id: item.id }
end sub
