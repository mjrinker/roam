' Plays a movie or an episode. Roam stores a video as one or more files played end to end, so this plays one file at a time and moves on to
' the next; it skips the scenes this profile skips, offers "Skip intro" style buttons, remembers the place, and holds its place when the
' server limits how many can watch a title at once.

sub init()
  m.tasks = {}
  m.video = m.top.findNode("video")
  m.status = m.top.findNode("status")
  m.skipBox = m.top.findNode("skipBox")
  m.video.observeField("state", "onState")
  m.top.findNode("tick").observeField("fire", "onTick")
  m.top.findNode("saveTimer").observeField("fire", "onSaveTimer")
  m.top.findNode("beatTimer").observeField("fire", "onBeat")
  m.top.findNode("noticeTimer").observeField("fire", "onNoticeOver")
  m.manifest = invalid
  m.g = 0.0
  m.autoDone = {}
  m.lastJump = -1000.0
  m.button = invalid
  m.retried = false
end sub

sub activate()
  if m.manifest <> invalid then
    m.video.setFocus(true)
    return
  end if
  m.kind = m.top.params.kind
  m.id = m.top.params.id
  m.queue = m.top.params.queue
  if m.queue = invalid then m.queue = []
  fetchManifest()
end sub

sub fetchManifest()
  path = "/api/play/" + m.kind + "/" + m.id + "?unsupportedCodecs=" + roamUnsupportedAudio()
  m.tasks.manifest = apiCall("GET", path, invalid, "onManifest")
end sub

sub say(text as String)
  m.status.text = text
  m.status.visible = text <> ""
end sub

sub onNoticeOver()
  say("")
end sub

sub onManifest(event as Object)
  r = event.getData()
  if r.status = 423 and r.json <> invalid then
    say(r.json.error + "  Press Back.")
    return
  end if
  if r.status <> 200 or r.json = invalid or r.json.segments = invalid or r.json.segments.Count() = 0 then
    say("This can't be played right now. Press Back.")
    return
  end if
  m.manifest = r.json
  m.autoDone = {}
  m.skips = m.manifest.skips
  startAt = 0.0
  if m.retryAt <> invalid then
    startAt = m.retryAt
    m.retryAt = invalid
  else if m.top.params.startOver <> true and m.manifest.resumeSeconds <> invalid and m.manifest.resumeSeconds > 0 and m.manifest.resumeSeconds < m.manifest.durationSeconds - 30 then
    startAt = m.manifest.resumeSeconds
  end if
  if m.manifest.notice <> invalid and m.manifest.notice <> "" then
    say(m.manifest.notice)
    m.top.findNode("noticeTimer").control = "start"
  end if
  m.top.findNode("tick").control = "start"
  m.top.findNode("saveTimer").control = "start"
  if m.manifest.heartbeat = true then m.top.findNode("beatTimer").control = "start"
  playAt(startAt)
end sub

' ── Playing ──
function streamFormatFor(container as Dynamic) as String
  if container = invalid then return "mp4"
  c = LCase(container)
  if c = "mkv" or c = "matroska" then return "mkv"
  if c = "webm" then return "webm"
  return "mp4"
end function

sub playAt(t as Float)
  loc = locatePart(m.manifest.segments, t)
  if loc = invalid then return
  m.segIndex = loc.index
  m.seg = loc.segment
  content = CreateObject("roSGNode", "ContentNode")
  content.url = m.seg.url
  content.streamFormat = streamFormatFor(m.seg.container)
  content.title = m.top.params.name
  if loc.localTime > 1 then content.PlayStart = Int(loc.localTime)
  m.video.content = content
  m.video.control = "play"
  m.video.setFocus(true)
end sub

' Jumps to global time t: within this file by seeking, or into another file by opening it.
sub seekGlobal(t as Float)
  duration = m.manifest.durationSeconds
  if t > duration - 1 then t = duration - 1
  if t < 0 then t = 0
  loc = locatePart(m.manifest.segments, t)
  if loc = invalid then return
  if loc.index = m.segIndex then
    m.video.seek = loc.localTime
  else
    playAt(t)
  end if
end sub

sub onState(event as Object)
  state = event.getData()
  if state = "playing" then
    m.retried = false
    if m.status.text = "Buffering..." then say("")
  else if state = "buffering" then
    ' (said briefly by Roku's own spinner)
  else if state = "finished" then
    nextPart()
  else if state = "error" then
    ' Streaming addresses expire: one retry with fresh ones, from where it was.
    if not m.retried then
      m.retried = true
      m.retryAt = m.g
      m.manifest = invalid
      fetchManifest()
    else
      say("This couldn't be played. Press Back.")
    end if
  end if
end sub

sub nextPart()
  if m.segIndex < m.manifest.segments.Count() - 1 then
    playAt(m.manifest.segments[m.segIndex + 1].startSeconds)
  else
    finishVideo()
  end if
end sub

sub finishVideo()
  saveProgress(true)
  if m.queue.Count() > 0 then
    ' On to the next episode of the season.
    m.id = m.queue[0]
    m.queue.Delete(0)
    m.manifest = invalid
    m.top.params.startOver = false
    m.g = 0.0
    fetchManifest()
  else
    leave()
  end if
end sub

sub onTick()
  if m.manifest = invalid or m.seg = invalid then return
  if m.video.state <> "playing" then return
  here = m.video.position
  m.g = globalTime(m.seg, here)
  if m.seg.inFileEndSeconds <> invalid and here >= m.seg.inFileEndSeconds then
    nextPart()
    return
  end if
  ' Scenes this profile skips (and mutes: see config.brs).
  scene = sceneAt(m.skips, m.g)
  if scene <> invalid and (scene.action = "skip" or roamMuteAsSkip()) and Abs(m.g - m.lastJump) > 1 then
    m.lastJump = m.g
    seekGlobal(scene.endSeconds)
    return
  end if
  updateSkipButton()
end sub

' "Skip intro" and the like: offered with a press of Down, or done by itself for a profile that skips that kind automatically.
sub updateSkipButton()
  b = skipButtonAt(m.manifest.skipSegments, m.g, m.manifest.durationSeconds)
  m.button = b
  if b = invalid then
    m.skipBox.visible = false
    return
  end if
  auto = m.manifest.autoSkip
  if auto <> invalid and auto[b.kind] = true and not m.autoDone.DoesExist(b.kind) then
    m.autoDone[b.kind] = true
    m.skipBox.visible = false
    seekGlobal(b.toSeconds)
    return
  end if
  m.top.findNode("skipLabel").text = b.label
  m.skipBox.visible = true
end sub

' ── Remembering the place, and the playing-at-once limit ──
sub onSaveTimer()
  if m.video.state = "playing" then saveProgress(false)
end sub

sub saveProgress(finished as Boolean)
  if m.manifest = invalid or m.kind = "extra" then return
  body = { ownerKind: m.kind, ownerId: m.id, positionSeconds: Int(m.g), durationSeconds: Int(m.manifest.durationSeconds), finished: finished }
  m.tasks.save = apiCall("PATCH", "/api/watch-state", body, "onSaved")
end sub

sub onSaved(event as Object)
end sub

sub onBeat()
  if m.manifest = invalid then return
  m.tasks.beat = apiCall("POST", "/api/playback/beat", { ownerKind: m.kind, ownerId: m.id, paused: m.video.state = "paused" }, "onBeatAnswer")
end sub

sub onBeatAnswer(event as Object)
  r = event.getData()
  if r.status = 423 then
    m.video.control = "pause"
    msg = "This isn't available any more."
    if r.json <> invalid and r.json.error <> invalid then msg = r.json.error
    say(msg + "  Press Back.")
  end if
end sub

' ── Leaving ──
sub leave()
  m.top.findNode("tick").control = "stop"
  m.top.findNode("saveTimer").control = "stop"
  m.top.findNode("beatTimer").control = "stop"
  m.video.control = "stop"
  if m.manifest <> invalid and m.manifest.heartbeat = true then m.tasks.ended = apiCall("POST", "/api/playback/end", {}, "onSaved")
  m.top.route = { name: "back" }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
  if not press then return false
  if key = "back" then
    saveProgress(false)
    leave()
    return true
  end if
  if key = "down" and m.button <> invalid then
    seekGlobal(m.button.toSeconds)
    return true
  end if
  return false
end function
