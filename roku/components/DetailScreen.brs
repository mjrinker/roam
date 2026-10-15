' A movie or a show: what it is, and what to play. A show lists one season's episodes and can change season.
sub init()
  m.tasks = {}
  m.list = m.top.findNode("list")
  m.list.observeField("itemSelected", "onSelected")
  m.actions = []
  m.lang = "en"
end sub

sub activate()
  if m.loaded = true then
    m.list.setFocus(true)
    return
  end if
  load(invalid)
end sub

sub load(season as Dynamic)
  p = m.top.params
  path = "/api/v1/servers/" + p.serverId + "/titles/" + p.id
  if season <> invalid then path = path + "?season=" + Stri(season).Trim()
  m.tasks.detail = apiCall("GET", path, invalid, "onDetail")
end sub

sub onDetail(event as Object)
  r = event.getData()
  status = m.top.findNode("status")
  if r.status <> 200 or r.json = invalid then
    status.text = "Couldn't load this. Press Back, then try again."
    return
  end if
  d = r.json
  m.d = d
  m.loaded = true
  m.top.findNode("poster").uri = d.posterUrl
  m.top.findNode("name").text = d.name
  parts = []
  if d.year <> invalid then parts.push(Stri(d.year).Trim())
  if d.runtimeSeconds <> invalid then parts.push(formatClock(d.runtimeSeconds))
  if d.certification <> invalid and d.certification <> "" then parts.push(d.certification)
  meta = ""
  for i = 0 to parts.Count() - 1
    if i > 0 then meta = meta + "  ·  "
    meta = meta + parts[i]
  end for
  m.top.findNode("meta").text = meta
  m.top.findNode("overview").text = d.overview
  content = CreateObject("roSGNode", "ContentNode")
  m.actions = []
  if d.type = "movie" then
    buildMovie(d)
  else if d.type = "show" then
    buildShow(d)
  else
    status.text = "This can't be played on Roku yet. Use the web or another app."
    return
  end if
  m.mainActions = m.actions
  status.visible = false
  showActions(m.actions)
end sub

' Puts a list of actions on the screen (the main ones, or the chapters, or the subtitles to choose from).
sub showActions(actions as Object)
  m.actions = actions
  content = CreateObject("roSGNode", "ContentNode")
  for each a in actions
    node = content.createChild("ContentNode")
    node.title = a.label
  end for
  m.list.content = content
  m.list.visible = true
  m.list.jumpToItem = 0
  m.list.setFocus(true)
end sub

sub buildMovie(d as Object)
  p = m.top.params
  label = "Play"
  if d.resume <> invalid then label = "Resume from " + formatClock(d.resume.positionSeconds)
  m.actions.push({ label: label, kind: "play", params: { serverId: p.serverId, kind: "title", id: d.id, name: d.name, queue: [] } })
  if d.resume <> invalid then m.actions.push({ label: "Start over", kind: "play", params: { serverId: p.serverId, kind: "title", id: d.id, name: d.name, startOver: true, queue: [] } })
  if d.chapters <> invalid and d.chapters.Count() > 0 then m.actions.push({ label: "Chapters", kind: "chapters" })
  m.actions.push({ label: subtitleLabel(), kind: "subtitles" })
  m.actions.push({ label: "Subtitle language: " + languageName(m.lang), kind: "language" })
end sub

' ── Subtitles (searched on OpenSubtitles by the server; shown by the player as words on the picture) ──
function languages() as Object
  return [{ code: "en", name: "English" }, { code: "es", name: "Spanish" }, { code: "fr", name: "French" }, { code: "de", name: "German" }, { code: "pt", name: "Portuguese" }, { code: "it", name: "Italian" }]
end function

function languageName(code as Dynamic) as String
  if code = invalid then code = "en"
  for each l in languages()
    if l.code = code then return l.name
  end for
  return code
end function

function subtitleLabel() as String
  if m.cues <> invalid then return "Subtitles: " + m.cueName + "   (change)"
  return "Subtitles: off   (search)"
end function

sub searchSubtitles()
  m.top.findNode("status").text = "Looking for subtitles..."
  m.top.findNode("status").visible = true
  m.list.visible = false
  lang = m.lang
  if lang = invalid then lang = "en"
  m.tasks.subs = apiCall("GET", "/api/subtitles/search?ownerKind=title&ownerId=" + m.top.params.id + "&languages=" + lang, invalid, "onSubtitleResults")
end sub

sub onSubtitleResults(event as Object)
  r = event.getData()
  status = m.top.findNode("status")
  if r.status <> 200 or r.json = invalid or r.json.results = invalid then
    msg = "Couldn't look for subtitles."
    if r.json <> invalid and r.json.error <> invalid then msg = r.json.error
    status.text = msg
    m.list.visible = true
    m.list.setFocus(true)
    return
  end if
  status.visible = false
  actions = [{ label: "Back", kind: "main" }]
  if m.cues <> invalid then actions.push({ label: "No subtitles", kind: "subtitlesOff" })
  for each s in r.json.results
    label = UCase(s.language) + "  ·  " + s.release
    if s.hashMatch = true then label = label + "  (made for this file)"
    actions.push({ label: label, kind: "subtitlePick", fileId: s.fileId, name: UCase(s.language) + " " + s.release })
  end for
  if r.json.results.Count() = 0 then actions.push({ label: "Nothing found in " + languageName(m.lang), kind: "main" })
  showActions(actions)
end sub

sub downloadSubtitle(a as Object)
  m.top.findNode("status").text = "Getting the subtitles..."
  m.top.findNode("status").visible = true
  m.list.visible = false
  m.pickedName = a.name
  m.tasks.sub = apiCall("POST", "/api/subtitles/download", { ownerKind: "title", ownerId: m.top.params.id, fileId: a.fileId }, "onSubtitleDownloaded")
end sub

sub onSubtitleDownloaded(event as Object)
  r = event.getData()
  status = m.top.findNode("status")
  if r.status = 200 and r.json <> invalid and r.json.cues <> invalid then
    m.cues = r.json.cues
    m.cueName = m.pickedName
    status.visible = false
  else
    msg = "Couldn't get those subtitles."
    if r.json <> invalid and r.json.error <> invalid then msg = r.json.error
    status.text = msg + "  Press OK."
    status.visible = true
  end if
  backToMain()
end sub

' The main list again, with the subtitle line brought up to date.
sub backToMain()
  actions = []
  for each a in m.mainActions
    if a.kind = "subtitles" then a.label = subtitleLabel()
    if a.kind = "language" then a.label = "Subtitle language: " + languageName(m.lang)
    actions.push(a)
  end for
  m.mainActions = actions
  showActions(actions)
end sub

sub showChapters()
  actions = [{ label: "Back", kind: "main" }]
  for each c in m.d.chapters
    actions.push({ label: formatClock(c.startSeconds) + "   " + c.title, kind: "play", params: { serverId: m.top.params.serverId, kind: "title", id: m.d.id, name: m.d.name, startAt: c.startSeconds, queue: [] } })
  end for
  showActions(actions)
end sub

sub nextLanguage()
  all = languages()
  index = 0
  for i = 0 to all.Count() - 1
    if all[i].code = m.lang then index = i
  end for
  m.lang = all[(index + 1) mod all.Count()].code
  backToMain()
end sub

sub buildShow(d as Object)
  p = m.top.params
  episodes = d.episodes
  ids = []
  for each e in episodes
    ids.push(e.id)
  end for
  if d.continueEpisodeId <> invalid then
    label = "Play"
    for each e in episodes
      if e.id = d.continueEpisodeId and e.inProgress then label = "Resume"
    end for
    m.actions.push({ label: label + " next episode", kind: "play", params: playParams(d.continueEpisodeId, ids, d.name) })
  end if
  if d.seasons.Count() > 1 then
    nextSeason = d.seasons[0]
    for each s in d.seasons
      if s > d.season and nextSeason <= d.season then nextSeason = s
    end for
    m.actions.push({ label: "Season " + Stri(d.season).Trim() + "   (change)", kind: "season", season: nextSeason })
  end if
  for each e in episodes
    mark = ""
    if e.watched then mark = "(watched) "
    title = e.name
    if title = invalid then title = "Episode " + Stri(e.number).Trim()
    m.actions.push({ label: mark + Stri(e.number).Trim() + ". " + title, kind: "play", params: playParams(e.id, ids, d.name) })
  end for
end sub

' The episode to play, and the ones after it in this season (so the next one starts by itself).
function playParams(episodeId as String, ids as Object, showName as String) as Object
  rest = []
  found = false
  for each id in ids
    if found then rest.push(id)
    if id = episodeId then found = true
  end for
  return { serverId: m.top.params.serverId, kind: "episode", id: episodeId, name: showName, queue: rest }
end function

sub onSelected()
  a = m.actions[m.list.itemSelected]
  if a.kind = "play" then
    params = a.params
    if m.cues <> invalid and params.kind = "title" then params.subtitles = m.cues
    m.top.route = { name: "play", params: params }
  else if a.kind = "season" then
    load(a.season)
  else if a.kind = "chapters" then
    showChapters()
  else if a.kind = "subtitles" then
    searchSubtitles()
  else if a.kind = "language" then
    nextLanguage()
  else if a.kind = "subtitlePick" then
    downloadSubtitle(a)
  else if a.kind = "subtitlesOff" then
    m.cues = invalid
    backToMain()
  else if a.kind = "main" then
    backToMain()
  end if
end sub
