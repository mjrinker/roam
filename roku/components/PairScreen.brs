' Signing in with a code: the TV shows five characters, the person types them at /link on a phone or computer where they are signed in.
sub init()
  m.tasks = {}
  m.timer = m.top.findNode("pollTimer")
  m.timer.observeField("fire", "onPoll")
  m.buttons = m.top.findNode("buttons")
  m.buttons.observeField("buttonSelected", "onButton")
end sub

sub activate()
  start()
end sub

sub start()
  m.timer.control = "stop"
  m.top.findNode("code").text = ""
  m.top.findNode("hint").text = ""
  m.top.findNode("step").text = "Getting a code..."
  m.buttons.buttons = []
  label = "Roku"
  di = CreateObject("roDeviceInfo")
  name = di.GetFriendlyName()
  if name <> invalid and name <> "" then label = name
  m.tasks.start = apiCall("POST", "/api/v1/device/start", { label: label }, "onStarted")
end sub

sub onStarted(event as Object)
  r = event.getData()
  if r.status <> 200 or r.json = invalid then
    m.top.findNode("step").text = "Roam can't be reached. Check the network connection."
    m.buttons.buttons = ["Try again"]
    m.buttons.setFocus(true)
    return
  end if
  m.deviceCode = r.json.deviceCode
  url = r.json.verificationUrl
  m.top.findNode("step").text = "On a phone or computer, go to " + url + " and sign in. Then type this code:"
  m.top.findNode("code").text = r.json.userCode
  m.top.findNode("hint").text = "This screen signs in by itself when you approve the code."
  m.timer.duration = r.json.interval
  m.timer.control = "start"
end sub

sub onPoll()
  m.tasks.poll = apiCall("POST", "/api/v1/device/poll", { deviceCode: m.deviceCode }, "onPolled")
end sub

sub onPolled(event as Object)
  r = event.getData()
  if r.json = invalid then return
  if r.json.status = "approved" then
    m.timer.control = "stop"
    regWrite("token", r.json.accessToken)
    m.top.route = { name: "paired" }
  else if r.json.status = "expired" then
    m.timer.control = "stop"
    start()
  end if
end sub

sub onButton()
  start()
end sub
