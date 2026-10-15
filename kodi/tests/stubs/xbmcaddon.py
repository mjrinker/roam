settings = {"server_url": "https://roam.example", "mute_as_skip": False}


class Addon:
    def getAddonInfo(self, key):
        return {"id": "plugin.video.roam", "profile": "/tmp/roam-kodi-test-profile", "path": "/tmp/roam-kodi-addon"}[key]

    def getSetting(self, key):
        return str(settings.get(key, ""))

    def getSettingBool(self, key):
        return bool(settings.get(key, False))
