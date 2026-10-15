"""Signing in with a code, and the saved sign-in (kept in the add-on's own data folder, never in a setting a person can see)."""
import json
import os

from .api import ApiClient, ApiError


class Store:
    """The saved token and choices: {token, server_id}."""

    def __init__(self, folder):
        self.path = os.path.join(folder, "auth.json")
        self.data = {}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                value = json.load(f)
                self.data = value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, **values):
        self.data.update({k: v for k, v in values.items() if v is not None})
        for k, v in values.items():
            if v is None:
                self.data.pop(k, None)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    def clear(self):
        self.data = {}
        try:
            os.remove(self.path)
        except OSError:
            pass


def start_code(base_url, label, opener=None):
    """Asks Roam for a code to show. Returns the answer: userCode, deviceCode, verificationUrl, interval, expiresIn."""
    return ApiClient(base_url, opener=opener).post("/api/v1/device/start", {"label": label})


def poll_code(base_url, device_code, opener=None):
    """One ask: {"status": "pending"|"expired"|"approved", ...}. A hiccup in the network counts as pending."""
    try:
        return ApiClient(base_url, opener=opener).post("/api/v1/device/poll", {"deviceCode": device_code})
    except ApiError as e:
        if e.status in (0, 429, 500, 502, 503):
            return {"status": "pending"}
        raise
