import io
import json
import unittest
import urllib.error

import conftest_path  # noqa: F401
from resources.lib import auth
from resources.lib.api import ApiClient, ApiError


class FakeResponse:
    def __init__(self, body, status=200):
        self._body = json.dumps(body).encode()
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener(answer, seen):
    def open_(req, timeout=0):
        seen.append(req)
        if isinstance(answer, Exception):
            raise answer
        return answer

    return open_


class Api(unittest.TestCase):
    def test_sends_the_token_and_a_json_body(self):
        seen = []
        c = ApiClient("https://roam.example/", "rdt_x", opener(FakeResponse({"ok": True}), seen))
        c.post("/api/v1/me/profile", {"viewerId": "a"})
        r = seen[0]
        self.assertEqual(r.full_url, "https://roam.example/api/v1/me/profile")
        self.assertEqual(r.get_method(), "POST")
        self.assertEqual(r.get_header("Authorization"), "Bearer rdt_x")
        self.assertEqual(json.loads(r.data), {"viewerId": "a"})

    def test_a_query_parameter_may_itself_be_called_path(self):
        seen = []
        ApiClient("https://roam.example", None, opener(FakeResponse({}), seen)).get("/x", path="Trips/2019")
        self.assertEqual(seen[0].full_url, "https://roam.example/x?path=Trips%2F2019")

    def test_builds_the_query_and_leaves_out_nothing_it_was_given_as_none(self):
        seen = []
        ApiClient("https://roam.example", None, opener(FakeResponse({}), seen)).get("/x", page="2", after=None, q="a b")
        self.assertEqual(seen[0].full_url, "https://roam.example/x?page=2&q=a+b")
        self.assertIsNone(seen[0].get_header("Authorization"))

    def test_an_error_carries_roams_own_words_and_code(self):
        err = urllib.error.HTTPError("u", 423, "Locked", {}, io.BytesIO(json.dumps({"error": "Every copy is being played.", "code": "busy"}).encode()))
        with self.assertRaises(ApiError) as cm:
            ApiClient("https://roam.example", None, opener(err, [])).get("/x")
        self.assertEqual((cm.exception.status, cm.exception.message, cm.exception.code), (423, "Every copy is being played.", "busy"))

    def test_no_connection_is_status_zero(self):
        with self.assertRaises(ApiError) as cm:
            ApiClient("https://roam.example", None, opener(urllib.error.URLError("down"), [])).get("/x")
        self.assertEqual(cm.exception.status, 0)

    def test_an_answer_that_is_not_json_is_empty_not_a_crash(self):
        class Odd(FakeResponse):
            def read(self):
                return b"<html>"

        self.assertEqual(ApiClient("https://roam.example", None, opener(Odd({}), [])).get("/x"), {})


class SignIn(unittest.TestCase):
    def test_a_hiccup_while_waiting_is_just_pending(self):
        self.assertEqual(auth.poll_code("https://roam.example", "d" * 30, opener(urllib.error.URLError("down"), [])), {"status": "pending"})

    def test_the_answer_is_passed_on(self):
        self.assertEqual(auth.poll_code("https://roam.example", "d" * 30, opener(FakeResponse({"status": "approved", "accessToken": "rdt_x"}), []))["status"], "approved")

    def test_the_saved_sign_in_is_kept_private_and_can_be_cleared(self):
        import os
        import tempfile

        folder = tempfile.mkdtemp()
        store = auth.Store(folder)
        store.set(token="rdt_x", server_id="s1")
        again = auth.Store(folder)
        self.assertEqual((again.get("token"), again.get("server_id")), ("rdt_x", "s1"))
        self.assertEqual(oct(os.stat(os.path.join(folder, "auth.json")).st_mode & 0o777), "0o600")
        again.set(server_id=None)
        self.assertIsNone(auth.Store(folder).get("server_id"))
        again.clear()
        self.assertIsNone(auth.Store(folder).get("token"))


if __name__ == "__main__":
    unittest.main()
