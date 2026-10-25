import contextlib
import importlib.util
from io import StringIO
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import migrate_standardized_models as migration
from verify_model_migration import compose_transform, decompose_transform, sha256, read_json


class ApplyMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root, self.target = self.base / 'editor', self.base / 'batch'
        self.models = self.root / 'assets/models'
        (self.models / 'tree').mkdir(parents=True)
        (self.models / 'tree/model.glb').write_bytes(b'old-model-bytes')
        primitive = {'id': 'placeholder-box', 'name': 'box', 'dimensions': {'w': 1, 'h': 1, 'd': 1}, 'source': {'type': 'primitive', 'shape': 'box'}}
        (self.models / 'placeholder-box').mkdir()
        (self.models / 'placeholder-box/meta.json').write_bytes(migration.json_bytes(primitive))
        (self.root / 'scenes/demo').mkdir(parents=True)
        (self.root / 'scenes/index.json').write_bytes(b'[]\n')
        self.old_transform = {'position': [1, 2, 3], 'rotation': [0, 30, 0], 'scale': [2, 2, 2]}
        self.document = {'meta': {'id': 'demo', 'version': 1, 'unit': 'm', 'up': '+Y'}, 'environment': {}, 'cameras': [],
                         'assets': [{'id': 'tree', 'ref': 'models/tree', 'transform': self.old_transform},
                                    {'id': 'box', 'ref': 'models/placeholder-box', 'transform': self.old_transform},
                                    {'id': 'missing', 'ref': 'models/missing', 'transform': self.old_transform}]}
        self.scene = self.root / 'scenes/demo/scene.json'
        self.scene.write_bytes(migration.json_bytes(self.document))
        bundle = self.target / 'AF-test'
        (bundle / 'model').mkdir(parents=True)
        self.new_file = bundle / 'model/AF-test.glb'
        self.new_file.write_bytes(b'new-standardized-bytes')
        manifest = {'asset_id': 'AF-test', 'asset_version': 1, 'processing_status': 'ready',
                    'artifacts': {'model': 'model/AF-test.glb'},
                    'coordinate_system': {'unit': 'cm', 'up_axis': '+Y', 'front_status': 'unverified'},
                    'bounds': {'dimensions_cm': [200, 500, 200], 'aabb': {'min': [-100, 0, -100], 'max': [100, 500, 100]}},
                    'object_label': {'display': '树'}, 'scale': {'status': 'estimated'}}
        (bundle / 'layout_manifest.json').write_bytes(migration.json_bytes(manifest))
        (self.root / 'src/scripts').mkdir(parents=True)
        for name in ['gen-manifest.mjs', 'model-catalog.mjs']:
            shutil.copy2(SCRIPTS / name, self.root / 'src/scripts' / name)
        correction = np.diag([2, 2, -2, 1])
        proposed = compose_transform(self.old_transform) @ correction
        trs, _ = decompose_transform(proposed)
        self.report = {'paths': {'models': str(self.models), 'scenes': str(self.root / 'scenes'), 'target': str(self.target)},
            'models': [{'legacy_ref': 'models/tree', 'legacy_id': 'tree', 'geometry_status': 'verified',
                        'target_bundle': 'AF-test', 'target_file': str(self.new_file), 'old_file_sha256': sha256(self.models / 'tree/model.glb'),
                        'target_file_sha256': sha256(self.new_file), 'target_m_to_legacy_matrix': correction.tolist()},
                       {'legacy_ref': 'models/placeholder-box', 'legacy_id': 'placeholder-box', 'geometry_status': 'builtin_primitive'}],
            'scenes': [{'scene': 'demo', 'source_sha256': sha256(self.scene), 'instances': [
                {'id': 'tree', 'ref': 'models/tree', 'status': 'verified_trs', 'proposed_transform': trs, 'proposed_matrix': proposed.tolist(), 'trs_matrix_error': 1e-12},
                {'id': 'box', 'ref': 'models/placeholder-box', 'status': 'retain_primitive'},
                {'id': 'missing', 'ref': 'models/missing', 'status': 'preexisting_missing_model'}]}],
            'summary': {'all_models_geometry_migratable': True, 'all_resolved_instances_geometry_migratable': True, 'inputs_unchanged': True,
                        'instance_counts': {'verified_trs': 1, 'retain_primitive': 1, 'preexisting_missing_model': 1},
                        'preexisting_missing_refs': {'models/missing': 1}, 'preexisting_missing_instances': 1}}
        self.report_path = self.root / 'report.json'
        self.report_path.write_bytes(migration.json_bytes(self.report))

    def tearDown(self):
        self.temporary.cleanup()

    def run_migration(self, apply=True):
        with contextlib.redirect_stdout(StringIO()):
            return migration.apply_migration(self.root, self.target, self.report_path, apply)

    def test_dry_run_does_not_modify_input(self):
        before = migration.inventory(self.root)
        self.run_migration(False)
        self.assertEqual(before, migration.inventory(self.root))

    def test_applies_exact_copy_preserves_missing_and_primitives_and_prevents_double_apply(self):
        old_scene = self.scene.read_bytes()
        original_b = migration.inventory(self.target)
        result = self.run_migration()
        self.assertEqual(migration.inventory(self.models), original_b)
        self.assertEqual(migration.inventory(self.target), original_b)
        backup = Path(result['backup'])
        self.assertEqual((backup / 'scenes/demo/scene.json').read_bytes(), old_scene)
        self.assertEqual((backup / 'models/tree/model.glb').read_bytes(), b'old-model-bytes')
        actual = read_json(self.scene)
        self.assertEqual(actual['assets'][0]['ref'], 'models/AF-test')
        self.assertEqual(actual['assets'][1:], self.document['assets'][1:])
        catalog = read_json(self.root / 'assets/model-catalog.json')['models']
        self.assertEqual(catalog['models/AF-test']['dimensions']['h'], 5)
        self.assertEqual(catalog['models/AF-test']['source']['unitScale'], .01)
        self.assertIn('models/placeholder-box', catalog)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.run_migration()

    def test_stale_scene_is_rejected_before_any_swap(self):
        self.scene.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Scene changed'):
            self.run_migration()
        self.assertTrue((self.models / 'tree/model.glb').exists())
        self.assertFalse((self.root / 'assets/model-migration.json').exists())

    def test_failure_after_swap_rolls_back_all_live_files(self):
        before_models = migration.inventory(self.models)
        before_scenes = migration.inventory(self.root / 'scenes')
        actual_write = migration.atomic_write
        def fail_scene(path, data):
            if path == self.scene:
                raise OSError('injected failure')
            actual_write(path, data)
        with patch.object(migration, 'atomic_write', side_effect=fail_scene):
            with self.assertRaisesRegex(OSError, 'injected failure'):
                self.run_migration()
        self.assertEqual(migration.inventory(self.models), before_models)
        self.assertEqual(migration.inventory(self.root / 'scenes'), before_scenes)
        self.assertFalse((self.root / 'assets/model-catalog.json').exists())


if __name__ == '__main__':
    unittest.main()
