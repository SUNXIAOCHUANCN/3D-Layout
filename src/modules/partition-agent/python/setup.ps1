$ErrorActionPreference = 'Stop'
$partitionPythonDirectory = $PSScriptRoot
python -m venv (Join-Path $partitionPythonDirectory '.venv')
if ($LASTEXITCODE -ne 0) { throw '无法创建插件 Python 环境，请安装 Python 3.9 或更高版本。' }
& (Join-Path $partitionPythonDirectory '.venv/Scripts/python.exe') -m pip install -r (Join-Path $partitionPythonDirectory 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '插件图像处理依赖安装失败。' }
