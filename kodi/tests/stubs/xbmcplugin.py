items = []
ended = []
resolved = []
content = []


def addDirectoryItem(handle, url, listitem, isFolder=False):
    items.append({"url": url, "li": listitem, "folder": isFolder})
    return True


def endOfDirectory(handle, succeeded=True, **kw):
    ended.append(succeeded)


def setContent(handle, c):
    content.append(c)


def setResolvedUrl(handle, ok, listitem):
    resolved.append((ok, listitem))


def reset():
    items.clear()
    ended.clear()
    resolved.clear()
    content.clear()
