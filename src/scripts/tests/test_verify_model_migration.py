"""Regression tests for migration evidence, not just metadata comparisons."""
import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import json

import numpy as np

SCRIPT = Path(__file__).resolve().parents[1] / 'verify_model_migration.py'
SPEC = importlib.util.spec_from_file_location('migration_audit', SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = audit
SPEC.loader.exec_module(audit)


def geometry(points, faces):
    points, faces = np.asarray(points, float), np.asarray(faces, int)
    tri = points[faces]
    front = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    front /= np.maximum(np.linalg.norm(front, axis=1, keepdims=True), 1e-30)
    return audit.Geometry(points, faces, front, [0] * len(faces), [{}],
                          np.zeros((len(faces), 3, 2)), np.ones((len(faces), 3, 4)),
                          np.repeat(front[:, None], 3, axis=1), {})


POINTS = [[0, 0, 0], [2, 0, 0], [.2, 3, 0], [.4, .7, 4]]
FACES = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]]


class MigrationTests(unittest.TestCase):
    def test_scale_axis_flip_translation_and_exporter_reindexing(self):
        a = geometry(POINTS, FACES)
        forward = np.eye(4)
        forward[:3, :3] = np.diag([.6, .6, -.6])
        forward[:3, 3] = [2, -1, 7]
        permutation = np.array([2, 0, 3, 1])
        inverse = np.argsort(permutation)
        b = geometry(audit.transform_points(a.points, forward)[permutation], inverse[a.triangles])
        candidates, _ = audit.find_corrections(a, b, 1e-6)
        self.assertTrue(candidates)
        _, correction, _, ids, unique = min(candidates, key=lambda x: x[0])
        np.testing.assert_allclose(correction @ forward, np.eye(4), atol=1e-10)
        self.assertTrue(audit.compare_surfaces(a, b, correction, ids, unique)['triangle_topology_equal'])

    def test_same_bounds_do_not_hide_geometry_change(self):
        a = geometry(POINTS + [[.5, .5, .5]], FACES)
        b = geometry(POINTS + [[1, .5, .5]], FACES)
        candidates, best = audit.find_corrections(a, b, 1e-5)
        self.assertFalse(candidates)
        self.assertGreater(best[0], .01)

    def test_identical_vertices_do_not_hide_missing_face(self):
        a, b = geometry(POINTS, FACES), geometry(POINTS, FACES[:-1])
        candidates, _ = audit.find_corrections(a, b, 1e-6)
        _, correction, _, ids, unique = candidates[0]
        self.assertFalse(audit.compare_surfaces(a, b, correction, ids, unique)['triangle_topology_equal'])

    def test_near_coincident_exporter_vertices_are_welded_within_budget(self):
        points = POINTS + [[2 + 1e-8, 0, 0]]
        a = geometry(points, FACES)
        faces = np.asarray(FACES)
        faces[faces == 1] = 4
        b = geometry(points, faces)
        candidates, _ = audit.find_corrections(a, b, 1e-6)
        _, correction, _, ids, unique = candidates[0]
        comparison = audit.compare_surfaces(a, b, correction, ids, unique, 1e-7)
        self.assertTrue(comparison['triangle_topology_equal'])
        self.assertLess(comparison['max_triangle_corner_error_m'], 1e-7)

    def test_float_noise_is_not_material_change_but_sampler_change_is(self):
        self.assertTrue(audit.equivalent({'roughness': .9}, {'roughness': .8999999761581421}))
        self.assertEqual(audit.difference_paths({'sampler': {'minFilter': 9729}},
                                                {'sampler': {'minFilter': 9987}}), ['sampler.minFilter'])

    def test_uv_change_is_reported(self):
        a, b = geometry(POINTS, FACES), geometry(POINTS, FACES)
        b.triangle_uvs[0, 0, 0] = .25
        candidates, _ = audit.find_corrections(a, b, 1e-6)
        _, correction, _, ids, unique = candidates[0]
        comparison = audit.compare_surfaces(a, b, correction, ids, unique)
        self.assertEqual(comparison['appearance_status'], 'differences_detected')
        self.assertEqual(comparison['max_base_color_uv_error'], .25)

    def test_world_transform_preserves_old_geometry(self):
        old = audit.compose_transform({'position': [10, -3, 8], 'rotation': [20, 71, -6], 'scale': [2, 3, -4]})
        forward = np.eye(4)
        forward[:3, :3] = np.diag([.3, .3, -.3])
        forward[:3, 3] = [1, 2, 3]
        new = old @ np.linalg.inv(forward)
        np.testing.assert_allclose(audit.transform_points(np.asarray(POINTS), old),
                                   audit.transform_points(audit.transform_points(np.asarray(POINTS), forward), new), atol=1e-12)

    def test_trs_round_trip_matches_three_xyz_with_negative_scale(self):
        for rotation in [[20, 45, 80], [10, 90, 20], [-80, -90, 2]]:
            old = audit.compose_transform({'position': [1, 2, 3], 'rotation': rotation, 'scale': [-2, 3, 4]})
            value, rebuilt = audit.decompose_transform(old)
            self.assertIsNotNone(value)
            np.testing.assert_allclose(old, rebuilt, atol=1e-12)

    def test_shear_requires_matrix_not_lossy_trs(self):
        old = audit.compose_transform({'position': [0, 0, 0], 'rotation': [0, 0, 0], 'scale': [2, 1, 1]})
        correction = audit.compose_transform({'position': [0, 0, 0], 'rotation': [0, 0, 45]})
        self.assertEqual(audit.decompose_transform(old @ correction), (None, None))

    def test_real_glb_node_transform_and_sparse_accessor(self):
        binary = np.asarray(POINTS, dtype='<f4').tobytes()
        # Sparse correction replaces vertex 1's x coordinate with 5.
        binary += bytes([1, 0, 0, 0]) + struct.pack('<fff', 5, 0, 0)
        binary += np.asarray(FACES, dtype='<u2').tobytes()
        document = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(binary)}],
                    'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 48},
                                    {'buffer': 0, 'byteOffset': 48, 'byteLength': 1},
                                    {'buffer': 0, 'byteOffset': 52, 'byteLength': 12},
                                    {'buffer': 0, 'byteOffset': 64, 'byteLength': 24}],
                    'accessors': [{'bufferView': 0, 'componentType': 5126, 'type': 'VEC3', 'count': 4,
                                   'sparse': {'count': 1, 'indices': {'bufferView': 1, 'componentType': 5121},
                                              'values': {'bufferView': 2}}},
                                  {'bufferView': 3, 'componentType': 5123, 'type': 'SCALAR', 'count': 12}],
                    'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'indices': 1}]}],
                    'nodes': [{'mesh': 0, 'translation': [10, 20, 30], 'scale': [2, 2, 2]}],
                    'scenes': [{'nodes': [0]}], 'scene': 0}
        js = json.dumps(document).encode()
        js += b' ' * (-len(js) % 4)
        binary += b'\0' * (-len(binary) % 4)
        body = struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binary), 0x004E4942) + binary
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.glb'
            path.write_bytes(struct.pack('<III', 0x46546C67, 2, len(body) + 12) + body)
            loaded = audit.Glb(path).geometry()
        np.testing.assert_allclose(loaded.points[1], [20, 20, 30])
        self.assertEqual(len(loaded.triangles), 4)

    def test_scene_missing_ref_and_primitives_are_distinct(self):
        doc = {'meta': {'unit': 'm', 'up': '+Y'}, 'assets': [
            {'id': 'box', 'ref': 'models/box', 'transform': {'position': [0, 0, 0], 'rotation': [0, 0, 0]}},
            {'id': 'missing', 'ref': 'models/missing', 'transform': {'position': [0, 0, 0], 'rotation': [0, 0, 0]}}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'scene.json'
            path.write_text(json.dumps(doc))
            result = audit.audit_scene(path, {'models/box': {'primitive': True}}, 1e-4, 1e-5)
        self.assertEqual(result['counts'], {'retain_primitive': 1, 'blocked': 1})
        self.assertFalse(result['geometry_migratable'])


if __name__ == '__main__':
    unittest.main()
