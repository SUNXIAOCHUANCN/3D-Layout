# 模型迁移验证

`verify_model_migration.py` 只读检查现有模型、标准化资产包和场景，写出报告及候选实例变换。
它不复制、替换模型，不改写任何场景，也不调用打标工作流。

## 运行

从 3D-Layout 根目录运行：

```powershell
python -m pip install -r src/scripts/migration-requirements.txt
python src/scripts/verify_model_migration.py --target 'G:\GraduateDesign\Assets\Models\sample_models_batch\sample_models_batch'
```

已有依赖时直接运行第二条命令即可。所有路径都可覆盖：

```powershell
python src/scripts/verify_model_migration.py --models '<A>' --scenes '<scenes>' --target '<B>' --output '<报告目录>'
```

默认报告在 `artifacts/model-migration/report.md` 和 `report.json`。输出目录必须与三个输入目录分离。
程序在运行前后计算全部输入文件的 SHA-256，确认没有修改、新增或删除输入文件。
这次使用 B 中已有的 `source.json.source_path` 建立对应关系，并校验存在的 `source_sha256`；
它们只用于本次历史迁移，不是通用工作流需要新增的信息。

## 验证范围

1. 解析实际 GLB：访问器、稀疏数据、节点层级、三角形及默认蒙皮姿态。
   蒙皮按当前 `AssetInstance.normalizeGltf` 的静态烘焙口径计算。
2. 将 B 的模型坐标换成米，枚举 48 种有符号坐标轴排列并拟合等比缩放和平移。
   支持当前工作流的坐标轴转换和反射，不依赖元数据中四舍五入后的缩放因子。
   任意角度的未知坐标旋转、形变或无法解析的扩展保守报告为未验证/阻塞。
3. 全量双向最近顶点检查，并比较全部三角形对应。
   导出器产生的近重合接缝点在显式容差内合并，再检查对应三角形的实际角点误差。
   仅包围盒相同或者仅顶点集合相同都不能通过。
4. 对对应三角形比较材质、解码后的贴图像素、基础色 UV、顶点色、法线、面朝向。
   材质数值允许 float32 往返误差。纹理采样方式等真实差异仍单独记录。
5. 对全部场景实例计算 `T_new = T_old @ C`，其中 `C` 把 B 的米坐标映射到 A 的局部坐标。
   计算世界空间表面误差上界，并验证新矩阵是否能无损表示成当前 Three.js XYZ 欧拉角的 TRS。
   剪切等情况标记 `verified_requires_instance_matrix`，不把不准确的分解当作通过。
6. 三个无 GLB 的 primitive 标记为需要保留的内置定义。

默认几何容差为 `0.0001 米 + 模型对角线 × 0.00001`；世界空间使用实例线性变换的谱范数传播误差，
并以相同规则检查。报告记录实际误差和阈值，可用 `--absolute-tolerance`、`--relative-tolerance` 修改。

## 如何解读结果

- `all_models_geometry_migratable`：所有旧 GLB 都能在容差内建立表面对应，没有资产包错误。
- `all_scenes_geometry_migratable`：所有现有实例能保留几何布局；必要时可能要求编辑器支持实例矩阵。
- `all_static_attributes_equal`：已检查的静态外观属性一致，且没有已知的外观检查缺口。
- `inputs_unchanged`：输入模型、资产包和场景内容保持不变。

退出码 0 表示全部模型和场景几何通过，2 表示存在阻塞；外观差异单独报告，不隐含在几何退出码中。
JSON 中包含逐模型校验、映射矩阵、文件哈希，以及逐实例的候选 TRS/矩阵；它不是已经迁移好的场景。
矩阵使用行主序二维数组、列向量，且先将 B 换成米。不能再重复应用单位转换。

报告没有进行浏览器截图对比、交互、动画、切线空间和全部扩展材质的视觉验收。
其他纹理通道使用特殊 UV 变换时会额外标记待审。
发现材质差异不代表坐标迁移失败，但不能据此承诺替换前后画面完全相同。

直接复制 B 覆盖 A 尚不能让现有编辑器正常使用：还需要适配资产索引、模型 URL、单位转换、
保留 primitive 定义并迁移旧实例。该验证程序不会执行这些第二阶段改动。

## 测试

```powershell
python -m unittest discover -s src/scripts/tests -p 'test_verify_model_migration.py' -v
```

## 执行替换

`migrate_standardized_models.py` 使用验证报告进行一次性迁移。默认只打印计划；显式加 `--apply` 才执行：

```powershell
python src/scripts/migrate_standardized_models.py --target 'G:\GraduateDesign\Assets\Models\sample_models_batch\sample_models_batch'
python src/scripts/migrate_standardized_models.py --target 'G:\GraduateDesign\Assets\Models\sample_models_batch\sample_models_batch' --apply
```

程序先核对 GLB 和场景哈希，再准备 B 的完整副本、新目录及新场景。
原 A 和整个 scenes 目录保存在 `artifacts/model-migration/backups/<迁移编号>/models`、`scenes`；
备份还包含验证报告、旧索引、逐文件哈希和迁移记录 `migration.json`。
准备成功后再替换，提交中途失败会恢复原模型、场景和索引。
已有迁移标记或源文件发生变化时拒绝重复执行。

替换后的 `assets/models` 与 B 逐文件、逐字节一致。
`assets/model-catalog.json` 是编辑器目录；`assets/builtin-models.json` 保存 primitive；
`assets/model-migration.json` 记录备份位置和本次资产哈希。这三者均在 B 的资产目录外。
已存在的缺失引用原样保留，并记录在迁移报告中。

迁移后的当前目录已经是 B，不再适用于默认参数的旧 A 验证器。
需要重新进行 A/B 几何验证时，用 `--models` 指定备份的 `models`，
用 `--scenes` 指定备份的 `scenes`，并将 `--output` 指向新的报告目录。
保留原 `report.json` 和 `browser-before.json`，作为本次迁移的固定基准。

浏览器验收需启动本地开发服务。下面记录实际 Three.js 渲染的逐实例世界包围盒，
替换后对比，并在独立临时场景测试新增模型 scale=1、点选、变换、复制、保存重开：

```powershell
node src/scripts/check_migration_browser.mjs --output=artifacts/model-migration/browser-before.json
# 在此执行迁移。before 基准只在迁移前采集一次，后续不要覆盖。
node src/scripts/check_migration_browser.mjs --output=artifacts/model-migration/browser-after.json --compare=artifacts/model-migration/browser-before.json --interaction
```

服务默认 `http://127.0.0.1:5184/`，可传 `--url=`；浏览器默认使用本机 Chrome/Edge。
PNG 截图与 JSON 同目录。测试场景执行后移除，不改写用户场景。

全部迁移相关测试：

```powershell
python -m unittest discover -s src/scripts/tests -p 'test_*.py' -v
node --test src/scripts/tests/model-catalog.test.mjs
```

## 将编号目录改为原始模型名

```powershell
python src/scripts/rename_model_directories.py
python src/scripts/rename_model_directories.py --apply
```

名称来自 `source.json.source_path`：例如 `tree1/model.glb` 对应目录 `tree1`。
程序先处理 Windows 非法名称和重名，再以两阶段移动重命名目录，同步替换场景中的模型引用并重建索引。
只改场景的 `ref`，保留位置、旋转、缩放、相机和其他字段。
模型包内部的稳定 `asset_id`、GLB 文件名及所有文件字节保持不变；目录名与稳定 ID 不再绑定。

完整映射保存到 `assets/model-directory-renames.json`，场景、旧索引和逐文件哈希保存在
`artifacts/model-directory-renames/<重命名编号>/`。失败会恢复原目录名、场景和索引；重复运行是空操作。
原先 `assets/model-migration.json` 的替换验收是历史记录；新的目录布局记录在其 `directoryRename` 字段。

重命名后可以用原迁移完成时的浏览器记录作为基准：

```powershell
node src/scripts/check_migration_browser.mjs --output=artifacts/model-directory-renames/browser-after.json --compare=artifacts/model-migration/browser-after.json --interaction
```
