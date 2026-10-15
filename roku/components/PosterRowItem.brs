sub onContent()
  c = m.top.itemContent
  if c = invalid then return
  m.top.findNode("poster").uri = c.hdPosterUrl
  m.top.findNode("title").text = c.title
  bar = m.top.findNode("bar")
  if c.progress <> invalid and c.progress > 0 then
    bar.width = Int(170 * c.progress)
    bar.visible = true
  else
    bar.visible = false
  end if
end sub
