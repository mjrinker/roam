' Small helpers shared by every component that includes this file. (BrightScript has no modules: each component lists the scripts it uses.)

' ── Saved sign-in (the device token and the chosen server) ──
function regRead(key as String) as Dynamic
  section = CreateObject("roRegistrySection", "roam")
  if section.Exists(key) then return section.Read(key)
  return invalid
end function

sub regWrite(key as String, value as String)
  section = CreateObject("roRegistrySection", "roam")
  section.Write(key, value)
  section.Flush()
end sub

sub regDelete(key as String)
  section = CreateObject("roRegistrySection", "roam")
  section.Delete(key)
  section.Flush()
end sub

' ── Talking to Roam ──
' Starts a request and returns the task; the caller keeps it (so it isn't collected) and observes "response".
' response = { status: 200, json: {...} } (status 0: no connection).
function apiCall(method as String, path as String, body as Dynamic, callback as String) as Object
  task = CreateObject("roSGNode", "ApiTask")
  request = { method: method, url: roamBaseUrl() + path, token: regRead("token") }
  if body <> invalid then request.body = FormatJson(body)
  task.request = request
  task.observeField("response", callback)
  task.control = "RUN"
  return task
end function

' ── Words ──
function formatClock(totalSeconds as Dynamic) as String
  s = Int(val(Str(totalSeconds)))
  if s < 0 then s = 0
  h = s \ 3600
  m = (s mod 3600) \ 60
  sec = s mod 60
  secText = Right("0" + Stri(sec).Trim(), 2)
  if h > 0 then return Stri(h).Trim() + ":" + Right("0" + Stri(m).Trim(), 2) + ":" + secText
  return Stri(m).Trim() + ":" + secText
end function

' A list item for a poster grid or row from one of the API's items.
function itemNode(item as Object) as Object
  node = CreateObject("roSGNode", "ContentNode")
  node.title = item.name
  node.hdPosterUrl = item.posterUrl
  node.shortDescriptionLine1 = item.name
  if item.subtitle <> invalid then node.shortDescriptionLine2 = item.subtitle
  if item.progress <> invalid then node.addFields({ progress: item.progress })
  node.addFields({ itemType: item.type, itemId: item.id, square: item.square = true })
  return node
end function
