"""A minimal DHIS2 Web API client, standard library only.

The suite talks to the API directly for everything that is not under test:
installing the app, seeding, reading back server state after every write
the app makes, and cleaning up.
"""

import base64
import json
import secrets
import string
import time
import urllib.error
import urllib.request
import uuid

UID_FIRST_CHARS = string.ascii_letters
UID_CHARS = string.ascii_letters + string.digits
UID_LENGTH = 11
JSON_TYPE = "application/json"
JSON_PATCH_TYPE = "application/json-patch+json"
DEFAULT_TIMEOUT_S = 180
NOT_FOUND = 404


def generate_uid():
    """A DHIS2 UID, generated client-side so it can be recorded before the
    object exists."""
    rest = "".join(secrets.choice(UID_CHARS) for _ in range(UID_LENGTH - 1))
    return secrets.choice(UID_FIRST_CHARS) + rest


class ApiError(Exception):
    def __init__(self, method, path, status, body):
        super().__init__(f"{method} {path} -> HTTP {status}: {body[:400]}")
        self.status = status
        self.body = body


class Api:
    def __init__(self, base_url, username, password):
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.auth_header = f"Basic {token}"

    def _send(self, method, path, data=None, content_type=JSON_TYPE):
        url = f"{self.base_url}/api/{path.lstrip('/')}"
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", self.auth_header)
        request.add_header("Accept", JSON_TYPE)
        if data is not None:
            request.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT_S) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")

    def request(self, method, path, body=None, content_type=JSON_TYPE, allow=()):
        """Sends a request and returns (status, parsed JSON or None). Any
        2xx is success; statuses in `allow` are returned instead of raised."""
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
        status, text = self._send(method, path, data, content_type)
        if not (200 <= status < 300) and status not in allow:
            raise ApiError(method, path, status, text)
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        return status, parsed

    def get(self, path, allow=()):
        return self.request("GET", path, allow=allow)[1]

    def get_or_none(self, path):
        status, parsed = self.request("GET", path, allow=(NOT_FOUND,))
        return None if status == NOT_FOUND else parsed

    def post(self, path, body):
        return self.request("POST", path, body)[1]

    def put(self, path, body):
        return self.request("PUT", path, body)[1]

    def patch(self, path, operations):
        return self.request("PATCH", path, operations, JSON_PATCH_TYPE)[1]

    def delete(self, path):
        """Deletes, treating "already gone" as success. Returns True when
        something was deleted."""
        status, _ = self.request("DELETE", path, allow=(NOT_FOUND,))
        return status != NOT_FOUND

    def upload_app(self, zip_path):
        """POST /api/apps with the zip as multipart form data. Any 2xx is
        success (201 on 2.42+, 204 on 2.41 and earlier)."""
        boundary = uuid.uuid4().hex
        with open(zip_path, "rb") as handle:
            payload = handle.read()
        name = zip_path.rsplit("/", 1)[-1]
        body = b"".join(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'.encode(),
                b"Content-Type: application/zip\r\n\r\n",
                payload,
                f"\r\n--{boundary}--\r\n".encode(),
            ]
        )
        content_type = f"multipart/form-data; boundary={boundary}"
        status, _ = self.request("POST", "apps", body, content_type)
        return status


def poll(check, timeout_s=45, interval_s=1.0):
    """Calls `check` until it returns a truthy value or the time runs out;
    returns the last value either way, so the caller asserts on it."""
    deadline = time.monotonic() + timeout_s
    value = check()
    while not value and time.monotonic() < deadline:
        time.sleep(interval_s)
        value = check()
    return value
