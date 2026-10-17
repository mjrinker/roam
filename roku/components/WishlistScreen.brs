' The wishlist: what the household that buys media could get next. Select one to want it, say you'll get it, or say you've got it.
' (Adding a wish needs typing, which is far easier in the web or phone app.)
sub init()
  m.list = m.top.findNode("list")
  m.list.observeField("itemSelected", "onSelected")
  m.actions = []
  m.canEdit = true
end sub

sub activate()
  if m.started = true then
    m.list.setFocus(true)
    return
  end if
  m.started = true
  m.top.findNode("title").text = "Wishlist"
  load()
end sub

sub load()
  apiCall("GET", "/api/servers/" + m.top.params.serverId + "/wishlist", invalid, "onWishes")
end sub

sub say(text as String)
  status = m.top.findNode("status")
  status.text = text
  status.visible = text <> ""
end sub

function statusOf(w as Object) as String
  if w.onServer <> invalid then return "on the server now"
  if w.status = "got" then return "got it"
  if w.status = "claimed" then
    if w.claimedByMe = true then return "you're getting this"
    who = "someone"
    if w.claimedByName <> invalid then who = w.claimedByName
    return who + " is getting this"
  end if
  noun = "want this"
  if w.wants = 1 then noun = "wants this"
  return Stri(w.wants).Trim() + " " + noun
end function

sub onWishes(event as Object)
  r = event.getData()
  if r.status <> 200 or r.json = invalid then
    say("Couldn't load the wishlist. Press Back, then try again.")
    return
  end if
  m.canEdit = r.json.canEdit <> false
  if r.json.items.Count() = 0 then
    say("Nothing on the wishlist yet. Add things on the web or in the phone app.")
    return
  end if
  actions = []
  for each w in r.json.items
    label = w.title
    if w.year <> invalid then label = label + " (" + Stri(w.year).Trim() + ")"
    actions.push({ label: label + "   -   " + statusOf(w), wish: w })
  end for
  m.wishes = actions
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

' What can be done with one wish: the first choice is made by pressing it again (OK on a wish steps it along).
function nextMove(w as Object) as Object
  if w.onServer <> invalid then return invalid
  if w.status = "got" then return { method: "PATCH", path: "/api/wishlist/" + w.id, body: { action: "reopen" } }
  if w.status = "claimed" then
    if w.claimedByMe = true then return { method: "PATCH", path: "/api/wishlist/" + w.id, body: { action: "got" } }
    return invalid
  end if
  if w.iWant <> true then return { method: "PUT", path: "/api/wishlist/" + w.id + "/want", body: { on: true } }
  return { method: "PATCH", path: "/api/wishlist/" + w.id, body: { action: "claim" } }
end function

sub onSelected()
  if m.canEdit <> true then return
  move = nextMove(m.actions[m.list.itemSelected].wish)
  if move = invalid then return
  say("Saving...")
  m.list.visible = false
  apiCall(move.method, move.path, move.body, "onDone")
end sub

sub onDone(event as Object)
  r = event.getData()
  if r.status <> 200 then
    say("That didn't save. Press Back, then try again.")
    return
  end if
  load()
end sub
