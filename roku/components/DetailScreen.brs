' A movie or a show: what it is, and what to play. A show lists one season's episodes and can change season.
sub init()
  m.tasks = {}
  m.list = m.top.findNode("list")
  m.list.observeField("itemSelected", "onSelected")
  m.actions = []
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
  for each a in m.actions
    node = content.createChild("ContentNode")
    node.title = a.label
  end for
  status.visible = false
  m.list.content = content
  m.list.visible = true
  m.list.setFocus(true)
end sub

sub buildMovie(d as Object)
  p = m.top.params
  label = "Play"
  if d.resume <> invalid then label = "Resume from " + formatClock(d.resume.positionSeconds)
  m.actions.push({ label: label, kind: "play", params: { serverId: p.serverId, kind: "title", id: d.id, name: d.name, queue: [] } })
  if d.resume <> invalid then m.actions.push({ label: "Start over", kind: "play", params: { serverId: p.serverId, kind: "title", id: d.id, name: d.name, startOver: true, queue: [] } })
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
    m.top.route = { name: "play", params: a.params }
  else if a.kind = "season" then
    load(a.season)
  end if
end sub
