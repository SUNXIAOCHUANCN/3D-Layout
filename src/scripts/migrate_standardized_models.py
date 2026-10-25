"""Apply a verified A -> standardized-B migration with complete data backups.

Dry run is the default. --apply copies B byte-for-byte, builds the external
catalog, and rewrites only verified scene refs/transforms plus a migration marker.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess

import numpy as np

from verify_model_migration import ROOT, compose_transform, read_json, sha256


def inventory(directory):
    return {p.relative_to(directory).as_posix(): sha256(p)
            for p in sorted(directory.rglob('*')) if p.is_file()}


def atomic_write(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + '.migration-tmp')
    if temporary.exists():
        raise ValueError(f'Temporary file already exists: {temporary}')
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def prepare_documents(report, scenes, migration):
    models = {m['legacy_ref']: m for m in report['models']}
    documents = {}
    for result in report['scenes']:
        path = scenes / result['scene'] / 'scene.json'
        if sha256(path) != result['source_sha256']:
            raise ValueError(f'Scene changed since verification: {path}')
        document = read_json(path)
        if document.get('meta', {}).get('modelMigration'):
            raise ValueError(f'Scene was already migrated: {path}')
        converted = deepcopy(document)
        if len(converted['assets']) != len(result['instances']):
            raise ValueError('Scene instance count changed')
        for asset, proof in zip(converted['assets'], result['instances']):
            if asset['id'] != proof['id'] or asset['ref'] != proof['ref']:
                raise ValueError('Scene instance identity mismatch')
            if proof['status'] == 'verified_trs':
                model = models[proof['ref']]
                proposed = proof['proposed_transform']
                expected = compose_transform(asset['transform']) @ np.asarray(model['target_m_to_legacy_matrix'])
                actual = compose_transform(proposed)
                proof_matrix = np.asarray(proof['proposed_matrix'])
                allowed_matrix_error = proof.get('trs_matrix_error', 0) + 1e-12
                if not np.allclose(expected, proof_matrix, atol=1e-12, rtol=1e-12) or np.max(np.abs(expected - actual)) > allowed_matrix_error:
                    raise ValueError(f'Candidate transform does not match proof: {asset["id"]}')
                asset['ref'] = f'models/{model["target_bundle"]}'
                asset['transform'] = deepcopy(proposed)
            elif proof['status'] not in {'retain_primitive', 'preexisting_missing_model'}:
                raise ValueError(f'Unresolved instance: {asset["id"]}: {proof["status"]}')
        converted['meta']['modelMigration'] = migration
        documents[result['scene']] = converted
    return documents


def check_applied(root, documents, target_inventory):
    if inventory(root / 'assets/models') != target_inventory:
        raise ValueError('Copied model tree differs from B')
    catalog = read_json(root / 'assets/model-catalog.json')['models']
    missing, checked = [], 0
    for name, expected in documents.items():
        actual = read_json(root / 'scenes' / name / 'scene.json')
        if actual != expected:
            raise ValueError(f'Migrated scene content mismatch: {name}')
        for asset in actual['assets']:
            if asset['ref'] not in catalog:
                missing.append({'scene': name, 'id': asset['id'], 'ref': asset['ref']})
            else:
                checked += 1
    return {'model_tree_identical_to_B': True, 'catalog_entries': len(catalog),
            'resolved_instances': checked, 'preserved_missing_instances': missing,
            'scenes_identical_to_verified_proposals': True}


def apply_migration(root, target, report_path, apply=False):
    root, target, report_path = root.resolve(), target.resolve(), report_path.resolve()
    models, scenes = root / 'assets/models', root / 'scenes'
    report = read_json(report_path)
    summary = report['summary']
    if not summary['all_models_geometry_migratable'] or not summary['all_resolved_instances_geometry_migratable'] or not summary['inputs_unchanged']:
        raise ValueError('Geometry verification did not pass')
    if Path(report['paths']['models']).resolve() != models or Path(report['paths']['scenes']).resolve() != scenes or Path(report['paths']['target']).resolve() != target:
        raise ValueError('Report belongs to different source/target directories')
    if target.is_relative_to(models) or models.is_relative_to(target):
        raise ValueError('Source and destination overlap')
    if (root / 'assets/model-migration.json').exists():
        raise ValueError('Migration marker already exists; refusing to migrate twice')
    for model in report['models']:
        if model['geometry_status'] == 'builtin_primitive':
            continue
        if model['geometry_status'] != 'verified':
            raise ValueError('Unverified model in report')
        old = models / model['legacy_id'] / 'model.glb'
        new = Path(model['target_file'])
        if not new.resolve().is_relative_to(target):
            raise ValueError('Target file escapes B directory')
        if sha256(old) != model['old_file_sha256'] or sha256(new) != model['target_file_sha256']:
            raise ValueError(f'Model changed since verification: {model["legacy_id"]}')
    now = datetime.now(timezone.utc)
    migration_id = now.strftime('%Y%m%dT%H%M%S%fZ')
    migration = {'id': migration_id, 'reportSha256': sha256(report_path), 'appliedAt': now.isoformat()}
    documents = prepare_documents(report, scenes, migration)
    plan = {'migration': migration, 'source': str(target), 'destination': str(models),
            'scenes': len(documents), 'instances': summary['instance_counts'],
            'preserve_missing_refs': summary['preexisting_missing_refs']}
    if not apply:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        print('Dry run only; use --apply to create backups and perform migration.')
        return plan

    backup = (root / 'artifacts/model-migration/backups' / migration_id).resolve()
    if not backup.is_relative_to(root / 'artifacts') or backup.exists():
        raise ValueError('Unsafe or existing backup directory')
    backup.mkdir(parents=True)
    stage = backup / 'prepared'
    (stage / 'assets').mkdir(parents=True)
    target_inventory = inventory(target)
    print(f'Preparing byte-identical B copy: {len(target_inventory)} files', flush=True)
    shutil.copytree(target, stage / 'assets/models', copy_function=shutil.copy2)
    if inventory(stage / 'assets/models') != target_inventory:
        raise ValueError('Staged copy verification failed')
    builtins = {}
    for model in report['models']:
        if model['geometry_status'] == 'builtin_primitive':
            builtins[model['legacy_ref']] = read_json(models / model['legacy_id'] / 'meta.json')
    (stage / 'assets/builtin-models.json').write_bytes(json_bytes({'models': builtins}))
    for name, document in documents.items():
        directory = stage / 'scenes' / name
        directory.mkdir(parents=True)
        (directory / 'scene.json').write_bytes(json_bytes(document))
    subprocess.run(['node', str(root / 'src/scripts/gen-manifest.mjs'), '--root', str(stage)], check=True)
    catalog = read_json(stage / 'assets/model-catalog.json')['models']
    for model in report['models']:
        ref = model['legacy_ref'] if model['geometry_status'] == 'builtin_primitive' else f'models/{model["target_bundle"]}'
        if ref not in catalog:
            raise ValueError(f'Staged catalog is missing {ref}')
    # Back up every scene file, including views/index and existing historical backups.
    shutil.copytree(scenes, backup / 'scenes', copy_function=shutil.copy2)
    shutil.copy2(report_path, backup / 'verification-report.json')
    previous = backup / 'previous-assets'
    previous.mkdir()
    asset_files = ['model-catalog.json', 'builtin-models.json', 'model-migration.json']
    for name in asset_files:
        if (root / 'assets' / name).exists():
            shutil.copy2(root / 'assets' / name, previous / name)
    old_inventory = inventory(models)
    # Final guard after staging: no editor saves or input updates may slip into the swap.
    prepare_documents(report, scenes, migration)
    if inventory(target) != target_inventory:
        raise ValueError('B changed while preparing migration')
    state = {**plan, 'backup': str(backup), 'status': 'prepared', 'old_model_inventory': old_inventory,
             'target_inventory': target_inventory}
    (backup / 'migration.json').write_bytes(json_bytes(state))
    swapped = False
    try:
        # Paths are exact, checked workspace children; same-volume rename preserves the complete A backup.
        if models.resolve() != root / 'assets/models':
            raise ValueError('Unexpected destination path')
        models.rename(backup / 'models')
        swapped = True
        (stage / 'assets/models').rename(models)
        for name in ['builtin-models.json', 'model-catalog.json']:
            atomic_write(root / 'assets' / name, (stage / 'assets' / name).read_bytes())
        for name in documents:
            atomic_write(scenes / name / 'scene.json', (stage / 'scenes' / name / 'scene.json').read_bytes())
        atomic_write(scenes / 'index.json', (stage / 'scenes/index.json').read_bytes())
        post = check_applied(root, documents, target_inventory)
        if len(post['preserved_missing_instances']) != summary['preexisting_missing_instances']:
            raise ValueError('Migration introduced new missing model references')
        if inventory(target) != target_inventory:
            raise ValueError('B changed during migration')
        state.update({'status': 'applied', 'post_validation': post})
        (backup / 'migration.json').write_bytes(json_bytes(state))
        marker = {'migration': migration, 'backup': str(backup), 'source': str(target),
                  'postValidation': post, 'assetVersions': {m['target_bundle']: m['target_file_sha256'] for m in report['models'] if m['geometry_status'] == 'verified'}}
        atomic_write(root / 'assets/model-migration.json', json_bytes(marker))
        print(json.dumps({'backup': str(backup), 'post_validation': post}, ensure_ascii=False, indent=2), flush=True)
        return state
    except BaseException:
        if swapped:
            if models.exists():
                models.rename(backup / 'failed-models')
            (backup / 'models').rename(models)
            for name in documents:
                shutil.copy2(backup / 'scenes' / name / 'scene.json', scenes / name / 'scene.json')
            shutil.copy2(backup / 'scenes/index.json', scenes / 'index.json')
            for name in asset_files:
                old = previous / name
                live = root / 'assets' / name
                if old.exists():
                    shutil.copy2(old, live)
                elif live.exists():
                    live.unlink()
        state['status'] = 'rolled_back'
        (backup / 'migration.json').write_bytes(json_bytes(state))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--report', type=Path, default=ROOT / 'artifacts/model-migration/report.json')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    apply_migration(args.root, args.target, args.report, args.apply)


if __name__ == '__main__':
    main()
