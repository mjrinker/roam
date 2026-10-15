' The address of the Roam this channel talks to. scripts/package-roku.ts writes this file for your site.
function roamBaseUrl() as String
  return "https://roam-three-gray.vercel.app"
end function

' Roku plays Dolby Digital natively, so only the formats it can't play are listed (the server then offers a fixed copy where it has one).
function roamUnsupportedAudio() as String
  return "dtsc,dtsh,dtsl,dtse,dtsx,dtsy,ac-4,mha1,mhm1,alac,lpcm,sowt,twos,ipcm"
end function

' The sound of a muted scene can't be switched off reliably on every Roku, so a profile that mutes a scene has it skipped instead.
function roamMuteAsSkip() as Boolean
  return true
end function
