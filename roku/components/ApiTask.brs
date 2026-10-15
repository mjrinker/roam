sub init()
  m.top.functionName = "doRequest"
end sub

' One HTTPS request to Roam, answered with the status and the parsed JSON.
sub doRequest()
  req = m.top.request
  url = CreateObject("roUrlTransfer")
  url.SetCertificatesFile("common:/certs/ca-bundle.crt")
  url.InitClientCertificates()
  url.RetainBodyOnError(true)
  url.SetUrl(req.url)
  url.AddHeader("Accept", "application/json")
  if req.token <> invalid and req.token <> "" then url.AddHeader("Authorization", "Bearer " + req.token)
  port = CreateObject("roMessagePort")
  url.SetMessagePort(port)
  method = UCase(req.method)
  if method = "GET" then
    started = url.AsyncGetToString()
  else
    url.AddHeader("Content-Type", "application/json")
    url.SetRequest(method)
    body = ""
    if req.body <> invalid then body = req.body
    started = url.AsyncPostFromString(body)
  end if
  if not started then
    m.top.response = { status: 0, json: invalid }
    return
  end if
  msg = wait(20000, port)
  if type(msg) = "roUrlEvent" then
    json = invalid
    text = msg.GetString()
    if text <> invalid and text <> "" then json = ParseJson(text)
    m.top.response = { status: msg.GetResponseCode(), json: json }
  else
    url.AsyncCancel()
    m.top.response = { status: 0, json: invalid }
  end if
end sub
