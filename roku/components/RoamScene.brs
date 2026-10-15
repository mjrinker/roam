' The scene: keeps the screens in a stack, signs in, and routes from one screen to the next. A screen asks to go somewhere by setting
' its "route" field; the scene reads it here.

sub init()
  m.stack = []
  m.tasks = {}
  m.loading = m.top.findNode("loading")
  m.root = m.top.findNode("stackRoot")
  startUp()
end sub

sub startUp()
  m.loading.visible = true
  if regRead("token") = invalid then
    m.loading.visible = false
    resetTo("PairScreen", {})
    return
  end if
  m.tasks.me = apiCall("GET", "/api/v1/me", invalid, "onMe")
end sub

sub onMe(event as Object)
  r = event.getData()
  m.loading.visible = false
  if r.status = 401 then
    signOutLocally()
    resetTo("PairScreen", {})
  else if r.status <> 200 or r.json = invalid then
    resetTo("MessageScreen", { title: "Roam can't be reached", message: "Check the network connection and try again.", button: "Try again", afterwards: "retry" })
  else if r.json.profile = invalid then
    showProfiles(r.json.profiles)
  else
    chooseServer()
  end if
end sub

sub signOutLocally()
  regDelete("token")
  regDelete("server")
end sub

' ── Who's watching ──
sub showProfiles(profiles as Object)
  m.profiles = profiles
  items = []
  for each p in profiles
    note = ""
    if p.hasPin then note = "PIN"
    items.push({ id: p.id, label: p.name, note: note })
  end for
  resetTo("ChoiceScreen", { title: "Who's watching?", items: items, kind: "profile" })
end sub

sub pickProfile(id as String)
  profile = invalid
  for each p in m.profiles
    if p.id = id then profile = p
  end for
  if profile = invalid then return
  m.pendingProfile = id
  if profile.hasPin then
    dialog = CreateObject("roSGNode", "PinDialog")
    dialog.title = profile.name
    dialog.message = "Enter your PIN"
    dialog.pinPad.pinLength = 4
    dialog.buttons = ["OK", "Cancel"]
    dialog.observeField("buttonSelected", "onPinButton")
    m.pinDialog = dialog
    m.top.dialog = dialog
  else
    sendProfile(id, "")
  end if
end sub

sub onPinButton(event as Object)
  index = event.getData()
  pin = m.pinDialog.pin
  m.top.dialog.close = true
  if index = 0 then sendProfile(m.pendingProfile, pin)
end sub

sub sendProfile(id as String, pin as String)
  body = { viewerId: id }
  if pin <> "" then body.pin = pin
  m.tasks.profile = apiCall("POST", "/api/v1/me/profile", body, "onProfileChosen")
end sub

sub onProfileChosen(event as Object)
  r = event.getData()
  if r.status = 200 then
    chooseServer()
  else if r.status = 401 and r.json <> invalid and r.json.code = "incorrect_pin" then
    message("That PIN isn't right", "Try again.", "OK", "profiles")
  else if r.status = 429 then
    message("Too many tries", "Wait a few minutes and try again.", "OK", "profiles")
  else
    message("Couldn't choose that profile", "Try again.", "OK", "profiles")
  end if
end sub

' ── Which server ──
sub chooseServer()
  m.tasks.servers = apiCall("GET", "/api/v1/servers", invalid, "onServers")
end sub

sub onServers(event as Object)
  r = event.getData()
  if r.status <> 200 or r.json = invalid then
    message("Roam can't be reached", "Check the network connection and try again.", "Try again", "retry")
    return
  end if
  list = r.json.servers
  if list.Count() = 0 then
    message("No servers yet", "Join or create a server in Roam on a phone or computer, then open this channel again.", "Try again", "retry")
    return
  end if
  saved = regRead("server")
  if saved <> invalid then
    for each s in list
      if s.id = saved then
        showHome(s)
        return
      end if
    end for
  end if
  if list.Count() = 1 then
    showHome(list[0])
    return
  end if
  items = []
  for each s in list
    items.push({ id: s.id, label: s.name, note: "" })
  end for
  m.servers = list
  resetTo("ChoiceScreen", { title: "Choose a server", items: items, kind: "server" })
end sub

sub showHome(server as Object)
  regWrite("server", server.id)
  m.server = server
  resetTo("HomeScreen", { serverId: server.id })
end sub

' ── Screens ──
sub message(title as String, text as String, button as String, afterwards as String)
  resetTo("MessageScreen", { title: title, message: text, button: button, afterwards: afterwards })
end sub

sub resetTo(name as String, params as Object)
  for each n in m.stack
    m.root.removeChild(n)
  end for
  m.stack = []
  show(name, params)
end sub

sub show(name as String, params as Object)
  if m.stack.Count() > 0 then m.stack.Peek().visible = false
  screen = CreateObject("roSGNode", name)
  screen.params = params
  screen.observeField("route", "onRoute")
  m.root.appendChild(screen)
  m.stack.push(screen)
  screen.callFunc("activate")
end sub

sub pop()
  if m.stack.Count() <= 1 then return
  top = m.stack.Pop()
  m.root.removeChild(top)
  previous = m.stack.Peek()
  previous.visible = true
  previous.callFunc("activate")
end sub

sub onRoute(event as Object)
  r = event.getData()
  if r = invalid or r.name = invalid then return
  if r.name = "back" then
    pop()
  else if r.name = "retry" then
    startUp()
  else if r.name = "profiles" then
    m.tasks.me = apiCall("GET", "/api/v1/me", invalid, "onMe")
  else if r.name = "paired" then
    startUp()
  else if r.name = "chosen" then
    if r.kind = "profile" then
      pickProfile(r.id)
    else if r.kind = "server" then
      for each s in m.servers
        if s.id = r.id then showHome(s)
      end for
    end if
  else if r.name = "detail" then
    show("DetailScreen", { serverId: r.serverId, type: r.type, id: r.id })
  else if r.name = "browse" then
    show("BrowseScreen", { serverId: r.serverId, libraryId: r.libraryId, name: r.title, style: r.style })
  else if r.name = "search" then
    show("SearchScreen", { serverId: r.serverId })
  else if r.name = "play" then
    show("PlayerScreen", r.params)
  else if r.name = "switchProfile" then
    m.tasks.me = apiCall("GET", "/api/v1/me", invalid, "onMeProfiles")
  else if r.name = "signOut" then
    m.tasks.out = apiCall("DELETE", "/api/v1/session", invalid, "onSignedOut")
  end if
end sub

sub onMeProfiles(event as Object)
  r = event.getData()
  if r.status = 200 and r.json <> invalid then showProfiles(r.json.profiles) else startUp()
end sub

sub onSignedOut(event as Object)
  signOutLocally()
  resetTo("PairScreen", {})
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
  if press and key = "back" and m.stack.Count() > 1 then
    pop()
    return true
  end if
  return false
end function
