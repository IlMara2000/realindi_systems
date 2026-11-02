"""Restore an exported backup, or manage the public booking address."""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path


def restore(archive, destination):
    dest = Path(destination).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise ValueError('La destinazione deve essere vuota: nessun dato esistente viene sovrascritto.')
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='crm-restore-', dir=dest.parent) as temp:
        work = Path(temp)
        with zipfile.ZipFile(archive) as z:
            if sum(i.file_size for i in z.infolist()) > 2 * 1024**3:
                raise ValueError('Archivio troppo grande (massimo 2 GB).')
            if len(z.namelist()) != len(set(z.namelist())):
                raise ValueError('Archivio con voci duplicate.')
            if 'database.sql' not in z.namelist():
                raise ValueError('Backup non valido: database.sql mancante.')
            connection = sqlite3.connect(work / 'crm.sqlite3')
            # Restrict SQL export import: no ATTACH, extensions, virtual tables or external file access.
            denied = {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_CREATE_VTABLE}
            connection.set_authorizer(lambda action, a, b, schema, source: sqlite3.SQLITE_DENY if action in denied or action == sqlite3.SQLITE_FUNCTION and b == 'load_extension' else sqlite3.SQLITE_OK)
            connection.executescript(z.read('database.sql').decode('utf-8'))
            connection.set_authorizer(lambda *args: sqlite3.SQLITE_OK)
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Database danneggiato.')
            if connection.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('Relazioni del database non valide.')
            (work / 'documents').mkdir(mode=0o700)
            for storage, sha, size in connection.execute('SELECT storage_name,sha256,size FROM documents'):
                if len(storage) != 48 or any(c not in '0123456789abcdef' for c in storage):
                    raise ValueError('Nome documento non valido.')
                data = z.read('documents/' + storage)
                if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
                    raise ValueError('Verifica integrità documento fallita.')
                (work / 'documents' / storage).write_bytes(data)
            connection.execute('DELETE FROM sessions')
            connection.execute('DELETE FROM login_attempts')
            connection.execute("DELETE FROM settings WHERE key='password'")
            connection.commit()
            connection.close()
        dest.mkdir(exist_ok=True, mode=0o700)
        for p in work.iterdir():
            shutil.move(str(p), str(dest / p.name))
    return dest

def public_link(value=None):
    """Print the shareable booking link, optionally saving a new public origin first."""
    import app
    app.init()
    with app.db() as c:
        if value is not None:
            c.execute('UPDATE settings SET value=? WHERE key=?', (json.dumps(app.public_url(value)), 'public_url'))
        s = app.settings(c)
    base = s.get('public_url') or f"http://127.0.0.1:{os.environ.get('CRM_PORT', '8080')}"
    return base.rstrip('/') + '/book/' + s['booking_slug']

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Strumenti REALINDI CRM')
    commands = parser.add_subparsers(dest='command', required=True)
    restore_command = commands.add_parser('restore', help='Ripristina un backup in una cartella vuota')
    restore_command.add_argument('archive')
    restore_command.add_argument('--destination', required=True)
    link_command = commands.add_parser('public-url', help='Mostra o imposta l’indirizzo pubblico della pagina di prenotazione')
    link_command.add_argument('url', nargs='?', help='es. https://prenotazioni.esempio.it · vuoto per leggere il link attuale')
    args = parser.parse_args()
    try:
        if args.command == 'restore':
            target = restore(args.archive, args.destination)
            print(f'Backup ripristinato in {target}. Avvia con CRM_DATA_DIR impostata a questa cartella.')
        else:
            print(public_link(args.url))
    except Exception as exc:
        parser.exit(1, f'Operazione non riuscita: {exc}\n')
