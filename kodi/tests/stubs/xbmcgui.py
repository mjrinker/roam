NOTIFICATION_INFO = "info"
INPUT_NUMERIC = 0
ALPHANUM_HIDE_INPUT = 2
ACTION_PREVIOUS_MENU = 10
ACTION_NAV_BACK = 92
shown = []
answers = {"select": 0, "input": "", "yesno": True}


class ListItem:
    def __init__(self, label="", path=""):
        self.label = label
        self.path = path
        self.props = {}
        self.art = {}
        self.info = {}
        self.context = []

    def setProperty(self, k, v):
        self.props[k] = v

    def setArt(self, a):
        self.art = a

    def setInfo(self, kind, info):
        self.info = info

    def addContextMenuItems(self, items):
        self.context = items

    def getVideoInfoTag(self):
        raise AttributeError  # an older Kodi: the plain call is used


class Dialog:
    def ok(self, heading, text):
        shown.append(("ok", text))

    def notification(self, heading, text, icon=None, ms=0):
        shown.append(("notify", text))

    def select(self, heading, items):
        shown.append(("select", list(items)))
        return answers["select"]

    def input(self, heading, **kw):
        return answers["input"]

    def yesno(self, heading, text):
        return answers["yesno"]

    def textviewer(self, heading, text):
        shown.append(("text", text))


class DialogProgress:
    def create(self, heading, text):
        shown.append(("progress", text))

    def iscanceled(self):
        return False

    def close(self):
        pass


class WindowXMLDialog:
    def __init__(self, *a, **k):
        pass

    def show(self):
        pass

    def close(self):
        pass
