"""Read-only audit of legacy models/scenes against standardized GLB bundles.

Run from any directory:
  python src/scripts/verify_model_migration.py --target <batch_directory>

Only --output is written. No model, manifest, or scene is rewritten.
Matrices in the JSON report use row-major nested arrays and column vectors.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from dataclasses import dataclass
import hashlib
from io import BytesIO
import itertools
import json
from pathlib import Path
import struct
import sys
import time
import warnings

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation


ROOT = Path(__file__).resolve().parents[2]
DTYPES = {5120: 'i1', 5121: 'u1', 5122: '<i2', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def transform_points(points, matrix):
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def compose_transform(value):
    position = np.asarray(value['position'], dtype=float)
    rotation = np.asarray(value['rotation'], dtype=float)
    scale = np.asarray(value.get('scale', [1, 1, 1]), dtype=float)
    if any(v.shape != (3,) or not np.isfinite(v).all() for v in [position, rotation, scale]):
        raise ValueError('Invalid position/rotation/scale')
    result = np.eye(4)
    # Three.js Euler order XYZ: R = Rx @ Ry @ Rz (intrinsic XYZ).
    result[:3, :3] = Rotation.from_euler('XYZ', rotation, degrees=True).as_matrix() @ np.diag(scale)
    result[:3, 3] = position
    return result


def decompose_transform(matrix):
    """Return a losslessly representable TRS, or a matrix-only result for shear."""
    scale = np.linalg.norm(matrix[:3, :3], axis=0)
    if min(scale) < 1e-14:
        return None, None
    if np.linalg.det(matrix[:3, :3]) < 0:
        scale[0] *= -1
    rotation = matrix[:3, :3] / scale
    if np.max(np.abs(rotation.T @ rotation - np.eye(3))) > 1e-8:
        return None, None
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)  # Valid Euler gimbal lock.
        euler = Rotation.from_matrix(rotation).as_euler('XYZ', degrees=True)
    value = {'position': matrix[:3, 3].tolist(), 'rotation': euler.tolist(), 'scale': scale.tolist()}
    rebuilt = compose_transform(value)
    return value, rebuilt


@dataclass
class Geometry:
    points: np.ndarray
    triangles: np.ndarray
    # Front orientation in model coordinates, including negative node determinants.
    front_normals: np.ndarray
    triangle_materials: list
    material_signatures: list
    triangle_uvs: np.ndarray
    triangle_colors: np.ndarray
    normals: np.ndarray
    metadata: dict


class Glb:
    def __init__(self, path):
        self.path = Path(path)
        raw = self.path.read_bytes()
        if len(raw) < 20 or raw[:4] != b'glTF':
            raise ValueError('Not a binary glTF file')
        _, version, length = struct.unpack_from('<III', raw)
        if version != 2 or length != len(raw):
            raise ValueError('Invalid GLB header')
        offset, binary, document = 12, None, None
        while offset < len(raw):
            size, kind = struct.unpack_from('<II', raw, offset)
            chunk = raw[offset + 8:offset + 8 + size]
            if len(chunk) != size:
                raise ValueError('Truncated GLB chunk')
            if kind == 0x4E4F534A:
                document = json.loads(chunk)
            elif kind == 0x004E4942:
                binary = chunk
            offset += 8 + size
        if document is None:
            raise ValueError('Missing GLB JSON')
        self.doc, self.binary = document, binary
        self.buffers = []
        for buffer in document.get('buffers', []):
            self.buffers.append(self.uri(buffer['uri']) if 'uri' in buffer else binary)
        self.cache, self.image_cache = {}, {}

    def uri(self, value):
        if value.startswith('data:'):
            return base64.b64decode(value.split(',', 1)[1])
        if '://' in value:
            raise ValueError('Remote dependencies are unsupported')
        from urllib.parse import unquote
        path = (self.path.parent / unquote(value)).resolve()
        if not path.is_relative_to(self.path.parent.resolve()):
            raise ValueError('External dependency escapes model directory')
        return path.read_bytes()

    def accessor(self, index):
        if index in self.cache:
            return self.cache[index]
        a = self.doc['accessors'][index]
        dtype, width = np.dtype(DTYPES[a['componentType']]), WIDTHS[a['type']]
        if 'bufferView' in a:
            view = self.doc['bufferViews'][a['bufferView']]
            if 'EXT_meshopt_compression' in view.get('extensions', {}):
                raise ValueError('Meshopt compressed geometry is unsupported')
            result = np.ndarray((a['count'], width), dtype=dtype,
                                buffer=self.buffers[view.get('buffer', 0)],
                                offset=view.get('byteOffset', 0) + a.get('byteOffset', 0),
                                strides=(view.get('byteStride', dtype.itemsize * width), dtype.itemsize)).copy()
        else:
            result = np.zeros((a['count'], width), dtype=dtype)
        if a.get('sparse'):
            sparse = a['sparse']
            def sparse_data(item, item_dtype, components):
                v = self.doc['bufferViews'][item['bufferView']]
                return np.frombuffer(self.buffers[v.get('buffer', 0)], dtype=item_dtype,
                                     count=sparse['count'] * components,
                                     offset=v.get('byteOffset', 0) + item.get('byteOffset', 0))
            ids = sparse_data(sparse['indices'], DTYPES[sparse['indices']['componentType']], 1)
            result[ids] = sparse_data(sparse['values'], dtype, width).reshape(-1, width)
        if a.get('normalized') and dtype.kind in 'iu':
            result = result.astype(float) / np.iinfo(dtype).max
            if dtype.kind == 'i':
                result = np.maximum(result, -1)
        self.cache[index] = result
        return result

    def image_signature(self, index):
        if index not in self.image_cache:
            value = self.doc['images'][index]
            if 'uri' in value:
                data = self.uri(value['uri'])
            else:
                v = self.doc['bufferViews'][value['bufferView']]
                data = self.buffers[v.get('buffer', 0)][v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
            with Image.open(BytesIO(data)) as image:
                rgba = image.convert('RGBA')
                signature = f'{rgba.size}:{hashlib.sha256(rgba.tobytes()).hexdigest()}'
            self.image_cache[index] = signature
        return self.image_cache[index]

    def texture_signature(self, info):
        texture = self.doc['textures'][info['index']]
        if texture.get('extensions'):
            raise ValueError('Texture extension requires a separate appearance audit')
        sampler = self.doc.get('samplers', [])[texture['sampler']] if 'sampler' in texture else {}
        return {'image': self.image_signature(texture['source']),
                'sampler': {'wrapS': sampler.get('wrapS', 10497), 'wrapT': sampler.get('wrapT', 10497),
                            'magFilter': sampler.get('magFilter', 9729), 'minFilter': sampler.get('minFilter', 9987)},
                'scale': info.get('scale', 1), 'strength': info.get('strength', 1)}

    def material_signature(self, index):
        m = self.doc.get('materials', [])[index] if index is not None else {}
        pbr = m.get('pbrMetallicRoughness', {})
        textures = {}
        for key, value in {**m, **pbr}.items():
            if key.endswith('Texture'):
                textures[key] = self.texture_signature(value)
        return {'baseColor': pbr.get('baseColorFactor', [1, 1, 1, 1]),
                'metallic': pbr.get('metallicFactor', 1), 'roughness': pbr.get('roughnessFactor', 1),
                'emissive': m.get('emissiveFactor', [0, 0, 0]),
                'alphaMode': m.get('alphaMode', 'OPAQUE'), 'alphaCutoff': m.get('alphaCutoff', .5),
                'doubleSided': m.get('doubleSided', False),
                'extensions': m.get('extensions', {}), 'textures': textures}

    def geometry(self):
        d = self.doc
        supported = {'KHR_texture_transform', 'KHR_materials_unlit', 'KHR_materials_emissive_strength',
                     'KHR_materials_ior', 'KHR_materials_specular'}
        unknown = set(d.get('extensionsRequired', [])) - supported
        if unknown:
            raise ValueError(f'Unsupported required extensions: {sorted(unknown)}')
        worlds, active = {}, []
        def visit(index, parent, ancestors):
            if index in ancestors:
                raise ValueError('Cycle in GLB node hierarchy')
            n = d['nodes'][index]
            if 'matrix' in n:
                local = np.array(n['matrix']).reshape(4, 4, order='F')
            else:
                local = np.eye(4)
                local[:3, :3] = Rotation.from_quat(n.get('rotation', [0, 0, 0, 1])).as_matrix() @ np.diag(n.get('scale', [1, 1, 1]))
                local[:3, 3] = n.get('translation', [0, 0, 0])
            worlds[index] = parent @ local
            active.append(index)
            for child in n.get('children', []):
                visit(child, worlds[index], ancestors | {index})
        for index in d['scenes'][d.get('scene', 0)].get('nodes', []):
            visit(index, np.eye(4), set())
        points, triangles, fronts, material_ids, signatures, uvs, colors, normals = [], [], [], [], [], [], [], []
        appearance_warnings = []
        offset, skinned = 0, 0
        for index in active:
            n = d['nodes'][index]
            if 'mesh' not in n:
                continue
            world = worlds[index]
            mesh = d['meshes'][n['mesh']]
            for primitive in mesh['primitives']:
                if primitive.get('extensions'):
                    raise ValueError(f"Unsupported primitive extensions: {list(primitive['extensions'])}")
                attrs = primitive['attributes']
                pos = self.accessor(attrs['POSITION']).astype(float)
                if primitive.get('targets'):
                    raise ValueError('Morph targets need editor-specific validation')
                local_normal = self.accessor(attrs['NORMAL']).astype(float) if 'NORMAL' in attrs else None
                if 'skin' in n:
                    skinned += 1
                    skin = d['skins'][n['skin']]
                    inverse = self.accessor(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1) if 'inverseBindMatrices' in skin else np.repeat(np.eye(4)[None], len(skin['joints']), axis=0)
                    bones = np.array([worlds[j] @ inv for j, inv in zip(skin['joints'], inverse)])
                    joints = self.accessor(attrs['JOINTS_0']).astype(int)
                    weights = self.accessor(attrs['WEIGHTS_0']).astype(float)
                    sums = np.abs(weights).sum(axis=1)
                    zero = sums == 0
                    weights[~zero] /= sums[~zero, None]
                    weights[zero] = [1, 0, 0, 0]
                    # GLTFLoader binds identity; attached SkinnedMesh uses inverse world.
                    baked_world = np.zeros_like(pos)
                    for slot in range(4):
                        matrices = bones[joints[:, slot]]
                        values = np.einsum('nij,nj->ni', matrices[:, :3, :3], pos) + matrices[:, :3, 3]
                        baked_world += weights[:, slot, None] * values
                    pos = transform_points(baked_world, np.linalg.inv(world)).astype(np.float32).astype(float)
                ids = self.accessor(primitive['indices']).ravel().astype(np.int64) if 'indices' in primitive else np.arange(len(pos))
                mode = primitive.get('mode', 4)
                if mode == 4:
                    faces = ids.reshape(-1, 3)
                elif mode == 5:
                    faces = np.array([ids[i:i + 3] if i % 2 == 0 else ids[[i + 1, i, i + 2]] for i in range(len(ids) - 2)])
                elif mode == 6:
                    faces = np.array([[ids[0], ids[i], ids[i + 1]] for i in range(1, len(ids) - 1)])
                else:
                    raise ValueError(f'Non-triangle primitive mode {mode}')
                if 'skin' in n or local_normal is None:
                    # AssetInstance.normalizeGltf recomputes skinned mesh normals.
                    local_normal = np.zeros_like(pos)
                    tri = pos[faces]
                    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
                    for slot in range(3):
                        np.add.at(local_normal, faces[:, slot], cross)
                normal_matrix = np.linalg.inv(world[:3, :3]).T
                normal = local_normal @ normal_matrix.T
                normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-30)
                wp = transform_points(pos, world)
                tri = wp[faces]
                front = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]) * np.sign(np.linalg.det(world[:3, :3]))
                front /= np.maximum(np.linalg.norm(front, axis=1, keepdims=True), 1e-30)
                material_index = primitive.get('material')
                try:
                    signature = self.material_signature(material_index)
                except Exception as error:
                    signature = {'unverified': str(error)}
                    appearance_warnings.append(str(error))
                signature_id = len(signatures)
                signatures.append(signature)
                material = d.get('materials', [])[material_index] if material_index is not None else {}
                tex_infos = {k: v for k, v in {**material, **material.get('pbrMetallicRoughness', {})}.items() if k.endswith('Texture')}
                # Base-color UV is checked per triangle; other UV channels are explicit limitations.
                tex = tex_infos.get('baseColorTexture', {})
                tx = tex.get('extensions', {}).get('KHR_texture_transform', {})
                channel = tx.get('texCoord', tex.get('texCoord', 0))
                uv = self.accessor(attrs[f'TEXCOORD_{channel}']).astype(float) if f'TEXCOORD_{channel}' in attrs else np.zeros((len(pos), 2))
                angle = tx.get('rotation', 0)
                uv = (uv * tx.get('scale', [1, 1])) @ np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]).T + tx.get('offset', [0, 0])
                for key, info in tex_infos.items():
                    if key != 'baseColorTexture' and (info.get('texCoord', 0) != channel or info.get('extensions', {})):
                        appearance_warnings.append(f'{key}: additional texture-coordinate audit required')
                color = self.accessor(attrs['COLOR_0']).astype(float) if 'COLOR_0' in attrs else np.ones((len(pos), 4))
                if color.shape[1] == 3:
                    color = np.column_stack([color, np.ones(len(color))])
                points.append(wp)
                triangles.append(faces + offset)
                fronts.append(front)
                normals.append(normal[faces])
                uvs.append(uv[faces] if 'baseColorTexture' in tex_infos else np.zeros((len(faces), 3, 2)))
                colors.append(color[faces])
                material_ids.extend([signature_id] * len(faces))
                offset += len(pos)
        if not points:
            raise ValueError('GLB has no active mesh geometry')
        result = Geometry(np.concatenate(points), np.concatenate(triangles), np.concatenate(fronts),
                          material_ids, signatures, np.concatenate(uvs), np.concatenate(colors), np.concatenate(normals),
                          {'vertices': offset, 'triangles': sum(len(x) for x in triangles),
                           'skinned_primitives': skinned, 'animations': len(d.get('animations', [])),
                           'appearance_warnings': sorted(set(appearance_warnings))})
        if not np.isfinite(result.points).all():
            raise ValueError('Nonfinite geometry')
        return result


def signed_axes():
    yield np.eye(3)
    yield np.diag([1, 1, -1])  # Current Blender workflow's common handedness change.
    seen = {tuple(np.eye(3).ravel()), tuple(np.diag([1, 1, -1]).ravel())}
    for permutation in itertools.permutations(range(3)):
        for signs in itertools.product([1, -1], repeat=3):
            q = np.eye(3)[list(permutation)] * np.array(signs)[:, None]
            if tuple(q.ravel()) not in seen:
                yield q


def sample(points, count=768):
    return points[np.linspace(0, len(points) - 1, min(count, len(points)), dtype=int)]


def find_corrections(a, b, tolerance):
    """Fit all 48 signed-axis similarities; validate candidates using all vertices."""
    ap, bp = a.points, b.points
    ac, bc = (ap.min(0) + ap.max(0)) / 2, (bp.min(0) + bp.max(0)) / 2
    size_a, size_b = np.ptp(ap, axis=0), np.ptp(bp, axis=0)
    if np.linalg.norm(size_a) < 1e-14 or np.linalg.norm(size_b) < 1e-14:
        raise ValueError('Zero-size model')
    s = np.linalg.norm(size_b) / np.linalg.norm(size_a)
    au = np.unique(ap, axis=0)
    tree = cKDTree(au)
    candidates = []
    for q in signed_axes():
        correction = np.eye(4)
        correction[:3, :3] = q.T / s
        correction[:3, 3] = ac - correction[:3, :3] @ bc
        score = float(tree.query(transform_points(sample(bp), correction))[0].max())
        candidates.append((score, correction, q))
    candidates.sort(key=lambda x: x[0])
    passed = []
    best = None
    for score, correction, q in candidates:
        if passed and score > tolerance * 4:
            break
        corrected = transform_points(bp, correction)
        distance, indices = tree.query(corrected)
        # Refine scalar and translation from full vertex correspondences, not rounded metadata.
        if distance.max() < tolerance * 10:
            x, y = bp @ q, au[indices]
            xc, yc = x.mean(0), y.mean(0)
            factor = float(np.sum((x - xc) * (y - yc)) / np.sum((x - xc) ** 2))
            correction[:3, :3] = q.T * factor
            correction[:3, 3] = yc - factor * xc
            corrected = transform_points(bp, correction)
            distance, indices = tree.query(corrected)
        reverse = cKDTree(corrected).query(au)[0]
        error = float(max(distance.max(), reverse.max()))
        record = (error, correction, corrected, indices, au)
        if best is None or error < best[0]:
            best = record
        if error <= tolerance:
            passed.append(record)
        if not passed and score > tolerance * 4:
            break  # Even the best sampled candidate is well outside tolerance.
    return passed, best


def triangle_keys(ids):
    order = np.argsort(ids, axis=1, kind='stable')
    keys = np.take_along_axis(ids, order, axis=1)
    sorted_rows = np.lexsort((keys[:, 2], keys[:, 1], keys[:, 0]))
    return keys[sorted_rows], order[sorted_rows], sorted_rows


def weld_ids(points, epsilon):
    """Merge near-coincident exporter seam vertices within an explicit error budget."""
    parents = np.arange(len(points))
    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    for left, right in cKDTree(points).query_pairs(epsilon, output_type='ndarray'):
        left, right = find(left), find(right)
        if left != right:
            parents[max(left, right)] = min(left, right)
    labels = np.array([find(i) for i in range(len(points))])
    # Do not allow a long chain of small links to hide a large geometric collapse.
    if len(points) and np.max(np.linalg.norm(points - points[labels], axis=1)) > epsilon * 2:
        raise ValueError('Vertex welding forms an ambiguous chain; manual verification required')
    return labels


def equivalent(left, right):
    """Ignore float32 round-trip noise, while retaining real material changes."""
    if isinstance(left, dict) and isinstance(right, dict):
        return set(left) == set(right) and all(equivalent(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(equivalent(x, y) for x, y in zip(left, right))
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return bool(np.isclose(left, right, rtol=1e-6, atol=1e-7))
    return left == right


def difference_paths(left, right, prefix=''):
    if equivalent(left, right):
        return []
    if isinstance(left, dict) and isinstance(right, dict):
        return [p for k in sorted(set(left) | set(right))
                for p in difference_paths(left.get(k), right.get(k), f'{prefix}.{k}' if prefix else k)]
    return [prefix]


def compare_surfaces(a, b, correction, b_indices, unique_a, weld_tolerance=1e-6):
    a_indices = cKDTree(unique_a).query(a.points)[1]
    welded = weld_ids(unique_a, weld_tolerance)
    ak, ao, ar = triangle_keys(welded[a_indices[a.triangles]])
    bk, bo, br = triangle_keys(welded[b_indices[b.triangles]])
    topology = ak.shape == bk.shape and np.array_equal(ak, bk)
    result = {'triangle_topology_equal': bool(topology), 'topology_weld_tolerance_m': weld_tolerance}
    if not topology:
        result['appearance_status'] = 'unverified_topology_changed'
        return result
    # Canonical sorting aligns each face and each corner independently of exporter reindexing.
    def corners(values, rows, order):
        return np.take_along_axis(values[rows], order[..., None], axis=1)
    surface_a = corners(a.points[a.triangles], ar, ao)
    surface_b = corners(transform_points(b.points, correction)[b.triangles], br, bo)
    result['max_triangle_corner_error_m'] = float(np.max(np.linalg.norm(surface_a - surface_b, axis=2), initial=0))
    uv_a, uv_b = corners(a.triangle_uvs, ar, ao), corners(b.triangle_uvs, br, bo)
    color_a, color_b = corners(a.triangle_colors, ar, ao), corners(b.triangle_colors, br, bo)
    na = corners(a.normals, ar, ao)
    nb = corners(b.normals, br, bo) @ np.linalg.inv(correction[:3, :3])
    nb /= np.maximum(np.linalg.norm(nb, axis=2, keepdims=True), 1e-30)
    valid_normals = (np.linalg.norm(na, axis=2) > .5) & (np.linalg.norm(nb, axis=2) > .5)
    normal_dot = np.sum(na * nb, axis=2)
    fa = a.front_normals[ar]
    fb = b.front_normals[br] @ np.linalg.inv(correction[:3, :3])
    fb /= np.maximum(np.linalg.norm(fb, axis=1, keepdims=True), 1e-30)
    valid_front = (np.linalg.norm(fa, axis=1) > .5) & (np.linalg.norm(fb, axis=1) > .5)
    front_dot = np.sum(fa * fb, axis=1)
    material_changes = Counter()
    material_details = []
    for ia, ib in set(zip(np.asarray(a.triangle_materials)[ar], np.asarray(b.triangle_materials)[br])):
        sa, sb = a.material_signatures[ia], b.material_signatures[ib]
        paths = difference_paths(sa, sb)
        if paths:
            material_details.append({'old_primitive_material': int(ia), 'target_primitive_material': int(ib),
                                     'changed_paths': paths,
                                     'old': {k: sa.get(k) for k in set(sa) | set(sb) if not equivalent(sa.get(k), sb.get(k))},
                                     'target': {k: sb.get(k) for k in set(sa) | set(sb) if not equivalent(sa.get(k), sb.get(k))}})
        for key in set(sa) | set(sb):
            if not equivalent(sa.get(key), sb.get(key)):
                material_changes[key] += 1
    uv_error = float(np.max(np.abs(uv_a - uv_b), initial=0))
    color_error = float(np.max(np.abs(color_a - color_b), initial=0))
    normals_changed = int(np.sum(valid_normals & (normal_dot < .9999)))
    fronts_changed = int(np.sum(valid_front & (front_dot < .9999)))
    changes = bool(material_changes or uv_error > 2e-5 or color_error > 2e-5 or normals_changed or fronts_changed)
    result.update({'appearance_status': 'differences_detected' if changes else 'static_attributes_equal',
                   'material_changed_fields': dict(material_changes), 'max_base_color_uv_error': uv_error,
                   'material_differences': material_details,
                   'max_vertex_color_error': color_error, 'changed_normal_corners': normals_changed,
                   'changed_front_faces': fronts_changed})
    return result


def bundle_index(target):
    matches, problems = {}, []
    for directory in sorted(p for p in target.iterdir() if p.is_dir()):
        try:
            source = read_json(directory / 'source.json')
            manifest = read_json(directory / 'layout_manifest.json')
            source_path = source['source_path'].replace('\\', '/').removeprefix('./')
            if source_path in matches:
                raise ValueError(f'Duplicate source path: {source_path}')
            model = (directory / manifest['artifacts']['model']).resolve()
            if not model.is_relative_to(directory.resolve()) or not model.is_file():
                raise ValueError('Model artifact is missing or escapes bundle')
            if manifest.get('processing_status') != 'ready':
                raise ValueError('Bundle processing_status is not ready')
            validation = read_json(directory / 'validation.json')
            if validation.get('valid') is False or validation.get('success') is False:
                raise ValueError('Bundle validation failed')
            coord = manifest['coordinate_system']
            if coord.get('unit') not in {'m', 'cm', 'mm'} or coord.get('up_axis') != '+Y':
                raise ValueError('Unsupported target coordinate contract')
            matches[source_path] = {'directory': directory, 'model': model, 'source': source,
                                    'manifest': manifest, 'unit_factor': {'m': 1, 'cm': .01, 'mm': .001}[coord['unit']]}
        except Exception as error:
            problems.append({'bundle': directory.name, 'error': str(error)})
    return matches, problems


def audit_model(directory, bundle, absolute, relative):
    meta = read_json(directory / 'meta.json')
    result = {'legacy_ref': f'models/{directory.name}', 'legacy_id': directory.name, 'source_type': meta['source']['type']}
    if meta['source']['type'] == 'primitive':
        result.update({'geometry_status': 'builtin_primitive', 'appearance_status': 'unchanged',
                       'action': 'retain_primitive_definition; B has no replacement',
                       'old_dimensions_m': meta['dimensions']})
        return result, {'correction': np.eye(4), 'points': None, 'error': 0, 'primitive': True}
    old_path = directory / meta['source']['file']
    source_path = old_path.relative_to(directory.parent).as_posix()
    result['old_file_sha256'] = sha256(old_path)
    if bundle is None:
        raise ValueError(f'No matching target source_path: {source_path}')
    result.update({'target_asset_id': bundle['manifest']['asset_id'], 'target_bundle': bundle['directory'].name,
                   'target_file': str(bundle['model']), 'target_file_sha256': sha256(bundle['model']),
                   'target_unit_to_m': bundle['unit_factor']})
    source_hash = bundle['source'].get('source_sha256')
    result['source_hash_status'] = 'missing' if not source_hash else ('matched' if source_hash.lower() == result['old_file_sha256'] else 'mismatched')
    a, b = Glb(old_path).geometry(), Glb(bundle['model']).geometry()
    b.points *= bundle['unit_factor']
    extent = float(np.linalg.norm(np.ptp(a.points, axis=0)))
    tolerance = absolute + relative * extent
    result.update({'old_geometry': a.metadata, 'target_geometry': b.metadata,
                   'old_actual_dimensions_xyz_m': np.ptp(a.points, axis=0).tolist(),
                   'target_actual_dimensions_xyz_m': np.ptp(b.points, axis=0).tolist(),
                   'geometry_tolerance_m': tolerance})
    manifest_bounds = bundle['manifest'].get('bounds', {})
    declared = manifest_bounds.get('dimensions_cm')
    if declared:
        # dimensions_cm is explicitly in centimeters even if model unit later changes.
        result['target_metadata_dimension_error_m'] = float(np.max(np.abs(np.asarray(declared) * .01 - np.ptp(b.points, axis=0))))
    candidates, best = find_corrections(a, b, tolerance)
    if not candidates:
        result.update({'geometry_status': 'blocked_geometry_changed_or_unresolved',
                       'best_max_vertex_error_m': best[0] if best else None})
        return result, None
    evaluated = []
    for error, correction, corrected, indices, au in candidates:
        comparison = compare_surfaces(a, b, correction, indices, au, tolerance * .1)
        rank = (not comparison['triangle_topology_equal'], comparison['appearance_status'] != 'static_attributes_equal',
                comparison.get('max_base_color_uv_error', float('inf')),
                comparison.get('changed_normal_corners', 10**12), error)
        evaluated.append((rank, error, correction, comparison))
    evaluated.sort(key=lambda x: x[0])
    _, error, correction, comparison = evaluated[0]
    result.update(comparison)
    surface_error = max(error, comparison.get('max_triangle_corner_error_m', error))
    verified = comparison['triangle_topology_equal'] and surface_error <= tolerance
    result.update({'geometry_status': ('verified' if verified else 'blocked_surface_correspondence') if comparison['triangle_topology_equal'] else 'blocked_topology_changed',
                   'max_vertex_error_m': error, 'matching_axis_candidates': len(candidates),
                   'max_surface_error_m': surface_error,
                   'target_m_to_legacy_matrix': correction.tolist(),
                   'legacy_to_target_m_matrix': np.linalg.inv(correction).tolist(),
                   'matrix_linear_determinant': float(np.linalg.det(correction[:3, :3]))})
    if not verified:
        return result, None
    return result, {'correction': correction, 'points': b.points,
                    'radius': float(np.max(np.linalg.norm(b.points, axis=1))),
                    'error': surface_error, 'old_extent': extent, 'primitive': False}


def audit_scene(path, models, absolute, relative):
    doc = read_json(path)
    scene = {'scene': path.parent.name, 'source_sha256': sha256(path), 'instances': [], 'errors': []}
    if doc.get('meta', {}).get('unit') != 'm' or doc.get('meta', {}).get('up') != '+Y':
        scene['errors'].append('Scene is not meters/+Y')
    seen = set()
    for asset in doc.get('assets', []):
        item = {'id': asset.get('id'), 'ref': asset.get('ref')}
        try:
            if not isinstance(asset.get('id'), str) or asset['id'] in seen:
                raise ValueError('Missing or duplicate instance ID')
            seen.add(asset['id'])
            runtime = models.get(asset['ref'])
            if runtime is None:
                raise ValueError('Model mapping or geometry verification failed')
            old = compose_transform(asset['transform'])
            if asset.get('contentTransform') is not None:
                raise ValueError('Existing contentTransform needs explicit handling')
            if runtime['primitive']:
                item['status'] = 'retain_primitive'
            else:
                new = old @ runtime['correction']
                trs, rebuilt = decompose_transform(new)
                amplification = float(np.linalg.norm(old[:3, :3], ord=2))
                error_bound = amplification * runtime['error']
                tolerance = absolute + relative * amplification * runtime['old_extent']
                matrix_error = None if rebuilt is None else float(np.max(np.abs(rebuilt - new)))
                reconstruction_bound = None if rebuilt is None else float(np.linalg.norm(rebuilt[:3, :3] - new[:3, :3], ord=2) * runtime['radius'] + np.linalg.norm(rebuilt[:3, 3] - new[:3, 3]))
                safe_trs = reconstruction_bound is not None and error_bound + reconstruction_bound <= tolerance
                item.update({'status': 'verified_trs' if safe_trs else 'verified_requires_instance_matrix',
                             'proposed_transform': trs if safe_trs else None,
                             'proposed_matrix': new.tolist(), 'world_geometry_error_bound_m': error_bound,
                             'world_tolerance_m': tolerance, 'trs_matrix_error': matrix_error,
                             'trs_world_error_bound_m': reconstruction_bound})
                if error_bound > tolerance:
                    raise ValueError('World-space geometry error exceeds tolerance')
        except Exception as error:
            item.update({'status': 'blocked', 'error': str(error)})
        scene['instances'].append(item)
    scene['counts'] = dict(Counter(item['status'] for item in scene['instances']))
    scene['geometry_migratable'] = not scene['errors'] and not scene['counts'].get('blocked')
    return scene


def write_report(output, report):
    output.mkdir(parents=True, exist_ok=True)
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    summary = report['summary']
    lines = ['# 模型与场景迁移验证报告', '',
             '仅验证；没有替换模型或写入场景。矩阵为行主序二维数组，作用于列向量；模型先换算为米。', '',
             f"- 模型状态：`{summary['model_counts']}`",
             f"- 场景：{summary['scenes']}；实例：{summary['instances']}；实例状态：`{summary['instance_counts']}`",
             f"- 全部 GLB 几何可迁移：**{summary['all_models_geometry_migratable']}**",
             f"- 全部现有场景几何可迁移：**{summary['all_scenes_geometry_migratable']}**",
             f"- 原场景已缺失的模型引用：{summary['preexisting_missing_model_types']} 种、{summary['preexisting_missing_instances']} 个实例",
             f"- 所有引用有效模型的实例可迁移：**{summary['all_resolved_instances_geometry_migratable']}**",
             f"- 静态外观属性完全一致：**{summary['all_static_attributes_equal']}**",
             f"- 输入文件保持不变：**{summary['inputs_unchanged']}**", '',
             '**直接复制 B 覆盖 A 无法直接使用。** 当前编辑器还需要资产索引/URL适配、单位转换和旧实例迁移；'
             'B 不含三个 primitive 定义，必须由编辑器保留。', '',
             '此报告检查默认静态姿态、全部顶点和三角形对应、面朝向、法线、顶点色、基础色 UV、'
             '材质属性和解码后的贴图像素。截图、光照效果、动画及编辑交互尚未验证。'
             '外观属性差异不自动证明视觉不可恢复，也不能视为完全一致。', '',
             '## 模型结果', '',
             '| 旧模型 | B 资产 | 几何 | 最大顶点误差（米） | 外观属性 |',
             '|---|---|---|---:|---|']
    for m in report['models']:
        lines.append(f"| {m['legacy_id']} | {m.get('target_asset_id', '—')} | {m['geometry_status']} | {m.get('max_vertex_error_m', m.get('best_max_vertex_error_m', '—'))} | {m.get('appearance_status', '未验证')} |")
    lines += ['', '## 场景结果', '', '| 场景 | 实例数 | 状态 |', '|---|---:|---|']
    for s in report['scenes']:
        lines.append(f"| {s['scene']} | {len(s['instances'])} | {s['counts']} |")
    if summary['preexisting_missing_refs']:
        lines += ['', '## 原场景已有的模型缺失', '',
                  '以下引用在当前 A 中已经不存在，不能通过替换为 B 补齐。当前编辑器会显示缺失模型警示占位。', '',
                  '| 模型引用 | 实例数 |', '|---|---:|']
        lines += [f'| {key} | {count} |' for key, count in summary['preexisting_missing_refs'].items()]
    lines += ['', '## 外观差异类型', '', '| 属性路径 | 涉及模型数 |', '|---|---:|']
    lines += [f'| {key} | {count} |' for key, count in summary['material_difference_model_counts'].items()]
    if report['bundle_errors']:
        lines += ['', '## 资产包错误', '', '```json', json.dumps(report['bundle_errors'], ensure_ascii=False, indent=2), '```']
    if report['source_manifest_errors']:
        lines += ['', '## 源目录索引错误', '', '```json', json.dumps(report['source_manifest_errors'], ensure_ascii=False, indent=2), '```']
    lines += ['', '详细逐实例候选变换和失败原因见同目录 report.json。', '']
    (output / 'report.md').write_text('\n'.join(lines), encoding='utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, default=ROOT / 'assets/models')
    parser.add_argument('--scenes', type=Path, default=ROOT / 'scenes')
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/model-migration')
    parser.add_argument('--absolute-tolerance', type=float, default=1e-4, help='Absolute geometry tolerance in meters (default 0.1 mm)')
    parser.add_argument('--relative-tolerance', type=float, default=1e-5, help='Additional tolerance per model diagonal')
    args = parser.parse_args(argv)
    if args.absolute_tolerance < 0 or args.relative_tolerance < 0 or not np.isfinite([args.absolute_tolerance, args.relative_tolerance]).all():
        parser.error('Tolerances must be finite and nonnegative')
    for name in ['models', 'scenes', 'target', 'output']:
        setattr(args, name, getattr(args, name).resolve())
    for source in [args.models, args.scenes, args.target]:
        if not source.is_dir():
            parser.error(f'Input directory missing: {source}')
        if args.output.is_relative_to(source) or source.is_relative_to(args.output):
            parser.error('Output must be separate from input trees')
    started = time.time()
    input_paths = [p for root in [args.models, args.scenes, args.target] for p in root.rglob('*') if p.is_file()]
    baseline = {str(p): sha256(p) for p in input_paths}
    bundles, problems = bundle_index(args.target)
    report = {'schema_version': 1, 'paths': {k: str(getattr(args, k)) for k in ['models', 'scenes', 'target']},
              'tolerances': {'absolute_m': args.absolute_tolerance, 'relative': args.relative_tolerance},
              'matrix_convention': 'row-major nested arrays, column vectors; B converted to meters before correction',
              'bundle_errors': problems, 'source_manifest_errors': [], 'models': [], 'scenes': []}
    runtimes = {}
    directories = sorted(p for p in args.models.iterdir() if p.is_dir())
    try:
        source_manifest = read_json(args.models / 'manifest.json')['models']
        for directory in directories:
            if read_json(directory / 'meta.json') != source_manifest.get(f'models/{directory.name}'):
                report['source_manifest_errors'].append(f'Stale/missing manifest entry: models/{directory.name}')
        for ref in set(source_manifest) - {f'models/{directory.name}' for directory in directories}:
            report['source_manifest_errors'].append(f'Manifest-only reference: {ref}')
    except Exception as error:
        report['source_manifest_errors'].append(str(error))
    print(f'Validating {len(directories)} legacy model directories against {len(bundles)} target bundles...', flush=True)
    for i, directory in enumerate(directories, 1):
        try:
            meta = read_json(directory / 'meta.json')
            relative = (directory / meta['source'].get('file', 'model.glb')).relative_to(args.models).as_posix()
            result, runtime = audit_model(directory, bundles.get(relative), args.absolute_tolerance, args.relative_tolerance)
        except Exception as error:
            result, runtime = {'legacy_id': directory.name, 'legacy_ref': f'models/{directory.name}',
                               'geometry_status': 'blocked_error', 'error': str(error)}, None
        report['models'].append(result)
        if runtime is not None:
            runtimes[result['legacy_ref']] = runtime
        if i % 10 == 0 or runtime is None or i == len(directories):
            print(f"[{i}/{len(directories)}] {directory.name}: {result['geometry_status']} ({time.time() - started:.1f}s)", flush=True)
    for path in sorted(args.scenes.glob('*/scene.json')):
        try:
            scene = audit_scene(path, runtimes, args.absolute_tolerance, args.relative_tolerance)
        except Exception as error:
            scene = {'scene': path.parent.name, 'instances': [], 'errors': [str(error)], 'counts': {}, 'geometry_migratable': False}
        known_refs = {f'models/{directory.name}' for directory in directories}
        for item in scene['instances']:
            if item['ref'] not in known_refs:
                item['status'] = 'preexisting_missing_model'
                item['error'] = 'Reference is already absent from the source model library; target cannot restore it automatically'
        scene['counts'] = dict(Counter(item['status'] for item in scene['instances']))
        scene['geometry_migratable'] = not scene['errors'] and not any(scene['counts'].get(k) for k in ['blocked', 'preexisting_missing_model'])
        report['scenes'].append(scene)
        print(f"Scene {scene['scene']}: {scene['counts']}", flush=True)
    current_paths = {str(p) for root in [args.models, args.scenes, args.target] for p in root.rglob('*') if p.is_file()}
    changes = [path for path, value in baseline.items() if not Path(path).is_file() or sha256(path) != value]
    changes += sorted(current_paths - set(baseline))
    glbs = [m for m in report['models'] if m.get('source_type') != 'primitive']
    missing_refs = Counter(item['ref'] for scene in report['scenes'] for item in scene['instances'] if item['status'] == 'preexisting_missing_model')
    material_counts = Counter(path for m in glbs for path in set(p for diff in m.get('material_differences', []) for p in diff['changed_paths']))
    summary = {'model_counts': dict(Counter(m['geometry_status'] for m in report['models'])),
               'appearance_counts': dict(Counter(m.get('appearance_status', 'unverified') for m in glbs)),
               'scenes': len(report['scenes']), 'instances': sum(len(s['instances']) for s in report['scenes']),
               'instance_counts': dict(sum((Counter(s['counts']) for s in report['scenes']), Counter())),
               'all_models_geometry_migratable': bool(glbs) and not problems and not report['source_manifest_errors'] and all(m['geometry_status'] == 'verified' for m in glbs),
               'all_scenes_geometry_migratable': bool(report['scenes']) and not report['source_manifest_errors'] and all(s['geometry_migratable'] for s in report['scenes']),
               'all_resolved_instances_geometry_migratable': bool(report['scenes']) and not report['source_manifest_errors'] and all(not s['errors'] and not s['counts'].get('blocked') for s in report['scenes']),
               'preexisting_missing_model_types': len(missing_refs), 'preexisting_missing_instances': sum(missing_refs.values()),
               'preexisting_missing_refs': dict(missing_refs), 'material_difference_model_counts': dict(material_counts),
               'all_static_attributes_equal': bool(glbs) and all(m.get('appearance_status') == 'static_attributes_equal' and not m.get('old_geometry', {}).get('appearance_warnings') and not m.get('target_geometry', {}).get('appearance_warnings') for m in glbs),
               'inputs_unchanged': not changes, 'changed_input_files': changes,
               'elapsed_seconds': round(time.time() - started, 2)}
    report['summary'] = summary
    write_report(args.output, report)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f'Report: {args.output / "report.md"}', flush=True)
    # 2 means blocked geometry; appearance differences are reported separately.
    return 0 if summary['all_models_geometry_migratable'] and summary['all_scenes_geometry_migratable'] and summary['inputs_unchanged'] else 2


if __name__ == '__main__':
    sys.exit(main())
