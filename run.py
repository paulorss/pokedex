"""
Inicia a Pokédex local.

    python run.py              -> http://localhost:8000   (câmera funciona no próprio PC)
    python run.py --https      -> https://<ip-da-rede>:8443 (para usar a câmera do celular
                                  na mesma rede Wi-Fi; aceite o aviso de certificado)
"""
from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import socket
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parent
CERT_DIR = ROOT / "certs"


def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip: str) -> tuple[Path, Path]:
    """Gera um certificado autoassinado (necessário para a câmera fora do localhost)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    CERT_DIR.mkdir(exist_ok=True)
    cert_p, key_p = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    ip_file = CERT_DIR / "ip.txt"
    if cert_p.exists() and key_p.exists() and ip_file.exists() and ip_file.read_text() == ip:
        return cert_p, key_p

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pokedex.local")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            x509.IPAddress(ipaddress.ip_address(ip)),
        ]), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_p.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                        serialization.PrivateFormat.TraditionalOpenSSL,
                                        serialization.NoEncryption()))
    cert_p.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    ip_file.write_text(ip)
    return cert_p, key_p


def main() -> None:
    ap = argparse.ArgumentParser(description="Pokédex local")
    ap.add_argument("--https", action="store_true", help="habilita HTTPS (câmera em outros dispositivos)")
    ap.add_argument("--host", default=None)
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()

    ip = local_ip()
    if args.https:
        cert, key = ensure_cert(ip)
        port = args.port or 8443
        print(f"\n  Pokédex em:  https://localhost:{port}   |   na rede:  https://{ip}:{port}\n")
        uvicorn.run("app.server:app", host=args.host or "0.0.0.0", port=port,
                    ssl_certfile=str(cert), ssl_keyfile=str(key))
    else:
        port = args.port or 8000
        print(f"\n  Pokédex em:  http://localhost:{port}\n")
        uvicorn.run("app.server:app", host=args.host or "127.0.0.1", port=port)


if __name__ == "__main__":
    main()

