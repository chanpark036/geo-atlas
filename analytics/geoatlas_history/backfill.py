"""Fixed public archive registry with verified TLS, pinned public DNS and bounded downloads."""

from datetime import date, datetime, timezone
from contextlib import closing
import http.client
import ipaddress
import json
from pathlib import Path
import re
import socket
import ssl
import time
from urllib.parse import urlsplit
import uuid

from .captures import MAX_COMPRESSED, fingerprint


def approved_url(url, day):
    parsed = urlsplit(url)
    if (
        parsed.scheme != 'https'
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return False
    if parsed.hostname == 'subwaydata.nyc':
        return parsed.path == f'/data/subwaydatanyc_{day}_gtfsrt.tar.xz'
    if parsed.hostname == 'data.subwaydata.nyc':
        return (
            re.fullmatch(
                rf'/{day[:7]}/subwaydatanyc_{day}_gtfsrt_[a-z0-9]{{8,64}}\.tar\.xz', parsed.path
            )
            is not None
        )
    return False


class PublicHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        addresses = socket.getaddrinfo(self.host, 443, socket.AF_INET, socket.SOCK_STREAM)
        if not addresses or any(
            not ipaddress.ip_address(item[4][0]).is_global
            or ipaddress.ip_address(item[4][0]).is_multicast
            for item in addresses
        ):
            raise ValueError('Archive DNS returned an unapproved destination')
        connection = socket.create_connection((addresses[0][4][0], 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(connection, server_hostname=self.host)
        except BaseException:
            connection.close()
            raise


def fetch_day(day, directory, max_cache_bytes=2 * 1024**3):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        raise ValueError('Expected YYYY-MM-DD')
    date.fromisoformat(day)
    if not 1 <= max_cache_bytes <= 100 * 1024**3:
        raise ValueError('Invalid download cache budget')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f'subwaydatanyc_{day}_gtfsrt.tar.xz'
    manifest_path = destination.with_suffix('.json')
    if destination.exists():
        manifest = json.loads(manifest_path.read_text())
        if (
            destination.is_symlink()
            or destination.stat().st_size > MAX_COMPRESSED
            or fingerprint(destination) != manifest['sha256']
        ):
            raise ValueError('Cached archive is invalid')
        return {**manifest, 'path': str(destination), 'skipped': True}
    existing = sum(path.stat().st_size for path in directory.iterdir() if path.is_file())
    if existing >= max_cache_bytes:
        raise ValueError('Historical download cache capacity exceeded')
    original = f'https://subwaydata.nyc/data/subwaydatanyc_{day}_gtfsrt.tar.xz'
    current = original
    temporary = directory / f'.download-{uuid.uuid4()}'
    started = time.monotonic()
    try:
        for redirect in range(2):
            if not approved_url(current, day):
                raise ValueError('Unapproved historical archive destination')
            parsed = urlsplit(current)
            with closing(
                PublicHTTPSConnection(
                    parsed.hostname, timeout=30, context=ssl.create_default_context()
                )
            ) as client:
                client.request(
                    'GET',
                    parsed.path,
                    headers={
                        'User-Agent': 'GeoAtlas/0.1 historical backfill',
                        'Accept-Encoding': 'identity',
                    },
                )
                response = client.getresponse()
                if response.status in (301, 302, 307, 308) and redirect == 0:
                    current = response.getheader('Location', '')
                    continue
                if (
                    response.status != 200
                    or response.getheader('Content-Encoding', 'identity') != 'identity'
                ):
                    raise ValueError('Archive HTTP response rejected')
                declared = response.getheader('Content-Length')
                if declared is not None and (
                    not declared.isdigit() or int(declared) > MAX_COMPRESSED
                ):
                    raise ValueError('Historical download exceeds 128 MiB')
                size = 0
                with temporary.open('xb') as output:
                    while chunk := response.read(65536):
                        size += len(chunk)
                        if (
                            size > MAX_COMPRESSED
                            or existing + size > max_cache_bytes
                            or time.monotonic() - started > 120
                        ):
                            raise ValueError('Historical download exceeded resource bounds')
                        output.write(chunk)
                if not size or (declared is not None and size != int(declared)):
                    raise ValueError('Incomplete archive download')
                manifest = {
                    'source_url': original,
                    'resolved_url': current,
                    'sha256': fingerprint(temporary),
                    'compressed_bytes': size,
                    'fetched_at': datetime.now(timezone.utc).isoformat(),
                }
                manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
                temporary.replace(destination)
                return {**manifest, 'path': str(destination), 'skipped': False}
        raise ValueError('Archive redirect limit exceeded')
    finally:
        temporary.unlink(missing_ok=True)
