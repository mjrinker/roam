"""Talking to Roam's JSON API (docs/api.md). Standard library only, so it runs inside Kodi and in tests."""
import json
import urllib.error
import urllib.parse
import urllib.request


class ApiError(Exception):
    """A request that didn't succeed. status 0 means no connection."""

    def __init__(self, status, message="", code="", body=None):
        super().__init__(message or "Roam answered %s" % status)
        self.status = status
        self.message = message or ""
        self.code = code or ""
        self.body = body or {}


class ApiClient:
    def __init__(self, base_url, token=None, opener=None, timeout=20):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._open = opener or urllib.request.urlopen

    def request(self, method, path, body=None, query=None):
        url = self.base_url + path
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        data = None
        headers = {"Accept": "application/json", "User-Agent": "Roam-Kodi/1.0"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self._open(req, timeout=self.timeout) as res:
                status = res.status if hasattr(res, "status") else res.getcode()
                raw = res.read()
        except urllib.error.HTTPError as e:
            raw = e.read() if hasattr(e, "read") else b""
            parsed = _parse(raw)
            raise ApiError(e.code, parsed.get("error", ""), parsed.get("code", ""), parsed)
        except (urllib.error.URLError, OSError) as e:
            raise ApiError(0, str(getattr(e, "reason", e)), "network")
        return status, _parse(raw)

    def get(self, path, /, **query):
        return self.request("GET", path, query=query)[1]

    def post(self, path, body=None):
        return self.request("POST", path, body=body if body is not None else {})[1]

    def patch(self, path, body):
        return self.request("PATCH", path, body=body)[1]

    def put(self, path, body):
        return self.request("PUT", path, body=body)[1]

    def delete(self, path):
        return self.request("DELETE", path)[1]


def _parse(raw):
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}
