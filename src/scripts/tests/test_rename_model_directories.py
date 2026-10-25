import contextlib
from io import StringIO
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import rename_model_directories as rename


class RenameModelTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.models = self.root / 'assets/models'
        self.models.mkdir(parents=True)
        (self.root / 'src/scripts').mkdir(parents=True)
        for name in ['gen-manifest.mjs', 'model-catalog.mjs']:
            shutil.copy2(SCRIPTS / name, self.root / 'src/scripts' / name)
        (self.root / 'scenes/demo').mkdir(parents=True)
        for number, source in [(1, 'tree1/model.glb'), (2, 'rock/model.glb')]:
            self.add_model(f'AF-{number}', source)
        self.doc = {'meta': {'id': 'demo', 'version': 2, 'unit': 'm', 'up': '+Y', 'modelMigration': {'id': 'existing'}},
                    'environment': {}, 'cameras': [], 'assets': [
            {'id': f'object-{i}', 'ref': ref, 'name': f'Object {i}', 'visible': False,
             'transform': {'position': [i, 2, 3], 'rotation': [20, 30, 40], 'scale': [-2, 3, 4]}}
            for i, ref in enumerate(['models/AF-1', 'models/AF-2', 'models/placeholder-box', 'models/missing'])]}
        self.scene = self.root / 'scenes/demo/scene.json'
        self.scene.write_bytes(rename.json_bytes(self.doc))
        (self.root / 'assets/builtin-models.json').write_bytes(rename.json_bytes({'models': {
            'models/placeholder-box': {'id': 'placeholder-box', 'source': {'type': 'primitive', 'shape': 'box'}, 'dimensions': {'w': 1, 'h': 1, 'd': 1}, 'name': 'box'}}}))
        self.generate()

    def tearDown(self):
        self.temporary.cleanup()

    def add_model(self, asset_id, source):
        directory = self.models / asset_id
        (directory / 'model').mkdir(parents=True)
        (directory / f'model/{asset_id}.glb').write_bytes(asset_id.encode())
        manifest = {'asset_id': asset_id, 'asset_version': 1, 'processing_status': 'ready',
                    'artifacts': {'model': f'model/{asset_id}.glb'},
                    'coordinate_system': {'unit': 'cm', 'up_axis': '+Y'},
                    'bounds': {'dimensions_cm': [100, 200, 100], 'aabb': {'min': [-50, 0, -50], 'max': [50, 200, 50]}}}
        (directory / 'layout_manifest.json').write_bytes(rename.json_bytes(manifest))
        (directory / 'source.json').write_bytes(rename.json_bytes({'source_path': source}))

    def generate(self):
        subprocess.run(['node', str(self.root / 'src/scripts/gen-manifest.mjs')], check=True, stdout=subprocess.DEVNULL)

    def apply(self, apply=True):
        with contextlib.redirect_stdout(StringIO()):
            return rename.apply_rename(self.root, apply)

    def test_names_are_taken_from_original_source_paths(self):
        self.assertEqual(rename.original_name('agavelow/model.glb'), 'agavelow')
        self.assertEqual(rename.original_name('folder/My Tree.glb'), 'My-Tree')
        self.assertEqual(rename.original_name('tree1\\model.glb'), 'tree1')
        self.assertEqual(rename.safe_name('CON'), 'model-CON')
        with self.assertRaises(ValueError):
            rename.original_name('samples/models/model.glb')

    def test_dry_run_does_not_write(self):
        before = rename.inventory(self.root)
        self.apply(False)
        self.assertEqual(rename.inventory(self.root), before)

    def test_only_refs_change_and_all_bundle_bytes_and_stable_ids_survive(self):
        before = rename.inventory(self.models)
        result = self.apply()
        self.assertEqual(result['directories_to_rename'], 2)
        self.assertEqual(result['scene_refs_to_update'], 2)
        self.assertEqual(rename.inventory(self.models), rename.remap_inventory(before, {'AF-1': 'tree1', 'AF-2': 'rock'}))
        catalog = rename.read_json(self.root / 'assets/model-catalog.json')['models']
        self.assertEqual(catalog['models/tree1']['id'], 'AF-1')
        self.assertEqual(catalog['models/tree1']['source']['url'], '/assets/models/tree1/model/AF-1.glb')
        expected, _ = rename.rewrite_scene_refs(self.doc, {'models/AF-1': 'models/tree1', 'models/AF-2': 'models/rock'})
        self.assertEqual(rename.read_json(self.scene), expected)
        self.assertEqual((Path(result['backup']) / 'scenes/demo/scene.json').read_bytes(), rename.json_bytes(self.doc))
        before_second_run = rename.inventory(self.root)
        self.apply()
        self.assertEqual(rename.inventory(self.root), before_second_run)

    def test_failure_after_moves_restores_original_names_scene_bytes_and_catalog(self):
        before_models = rename.inventory(self.models)
        before_scenes = rename.inventory(self.root / 'scenes')
        before_catalog = (self.root / 'assets/model-catalog.json').read_bytes()
        with patch.object(rename.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'node')):
            with self.assertRaises(subprocess.CalledProcessError):
                self.apply()
        self.assertEqual(rename.inventory(self.models), before_models)
        self.assertEqual(rename.inventory(self.root / 'scenes'), before_scenes)
        self.assertEqual((self.root / 'assets/model-catalog.json').read_bytes(), before_catalog)

    def test_two_phase_rename_handles_swapped_names(self):
        (self.models / 'AF-1/source.json').write_bytes(rename.json_bytes({'source_path': 'AF-2/model.glb'}))
        (self.models / 'AF-2/source.json').write_bytes(rename.json_bytes({'source_path': 'AF-1/model.glb'}))
        self.apply()
        self.assertEqual((self.models / 'AF-2/model/AF-1.glb').read_bytes(), b'AF-1')
        self.assertEqual((self.models / 'AF-1/model/AF-2.glb').read_bytes(), b'AF-2')

    def test_duplicate_names_do_not_steal_another_models_natural_suffix(self):
        (self.models / 'AF-1/source.json').write_bytes(rename.json_bytes({'source_path': 'a/chair.glb'}))
        (self.models / 'AF-2/source.json').write_bytes(rename.json_bytes({'source_path': 'b/chair.glb'}))
        self.add_model('AF-3', 'c/chair-2.glb')
        plan = rename.create_plan(self.root)
        self.assertEqual({r['new_directory'] for r in plan}, {'chair', 'chair-2', 'chair-3'})


if __name__ == '__main__':
    unittest.main()
