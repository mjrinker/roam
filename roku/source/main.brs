' Roam for Roku: opens the scene, which does everything else.
sub main(args as Dynamic)
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.SetMessagePort(port)
  scene = screen.CreateScene("RoamScene")
  screen.Show()
  ' Deep links (a content id passed by the launcher) are not used yet.
  scene.launchArgs = args
  while true
    msg = wait(0, port)
    if type(msg) = "roSGScreenEvent" and msg.isScreenClosed() then return
  end while
end sub
