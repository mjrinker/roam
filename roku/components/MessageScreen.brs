sub init()
  m.buttons = m.top.findNode("buttons")
  m.buttons.observeField("buttonSelected", "onButton")
end sub

sub onParams()
  p = m.top.params
  m.top.findNode("title").text = p.title
  m.top.findNode("message").text = p.message
  m.buttons.buttons = [p.button]
end sub

sub activate()
  m.buttons.setFocus(true)
end sub

sub onButton()
  m.top.route = { name: m.top.params.afterwards }
end sub
