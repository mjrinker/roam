' Where things are in a video that is stored as one or more files played end to end (the same maths as the web and TV players).

' The part that holds global time t: { segment, localTime } where localTime is the position in the part's own file.
function locatePart(segments as Object, t as Float) as Object
  last = segments.Count() - 1
  for i = 0 to last
    seg = segments[i]
    segEnd = seg.startSeconds + seg.durationSeconds
    if t < segEnd or i = last then
      within = t - seg.startSeconds
      if within < 0 then within = 0
      if within > seg.durationSeconds then within = seg.durationSeconds
      offset = 0
      if seg.inFileOffsetSeconds <> invalid then offset = seg.inFileOffsetSeconds
      return { index: i, segment: seg, localTime: offset + within }
    end if
  end for
  return invalid
end function

' Global time for a position (seconds into the file that is playing).
function globalTime(seg as Object, filePosition as Float) as Float
  offset = 0
  if seg.inFileOffsetSeconds <> invalid then offset = seg.inFileOffsetSeconds
  return seg.startSeconds + (filePosition - offset)
end function

' The scene to skip or mute that holds global time t, or invalid.
function sceneAt(skips as Dynamic, t as Float) as Dynamic
  if skips = invalid then return invalid
  for each s in skips
    if t >= s.startSeconds - 0.02 and t < s.endSeconds - 0.02 then return s
  end for
  return invalid
end function

' The intro/recap/credits/preview button to offer at global time t: { label, toSeconds, kind } or invalid.
function skipButtonAt(segments as Dynamic, t as Float, duration as Float) as Dynamic
  if segments = invalid then return invalid
  for each s in segments
    if t >= s.startSeconds - 0.5 and t < s.endSeconds - 1 then
      label = "Skip intro"
      if s.kind = "recap" then label = "Skip recap"
      if s.kind = "outro" then label = "Skip credits"
      if s.kind = "preview" then label = "Skip preview"
      return { label: label, toSeconds: s.endSeconds, kind: s.kind }
    end if
  end for
  return invalid
end function

' The subtitle words to show at global time t, or "" when there are none. `cues` is the API's list of [start, end, text]; `offset` shifts the whole track.
function subtitleTextAt(cues as Dynamic, t as Float, offset as Float) as String
  if cues = invalid then return ""
  time = t - offset
  text = ""
  ' Cues are in order of start: look at the last few that started at or before this time.
  lo = 0
  hi = cues.Count()
  while lo < hi
    mid = (lo + hi) \ 2
    if cues[mid][0] <= time then lo = mid + 1 else hi = mid
  end while
  first = lo - 8
  if first < 0 then first = 0
  for i = first to lo - 1
    if cues[i][1] > time then
      if text <> "" then text = text + chr(10)
      text = text + cues[i][2]
    end if
  end for
  return text
end function
