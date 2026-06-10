#!/usr/bin/env bash
# ============================================================
# Gemini Relay Studio — Mac / Linux 一键启动（自动安装 Node.js）
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[Gemini Relay]${NC} $*"; }
success() { echo -e "${GREEN}[Gemini Relay]${NC} $*"; }
warn()    { echo -e "${YELLOW}[Gemini Relay]${NC} $*"; }
error()   { echo -e "${RED}[Gemini Relay] 错误：${NC}$*"; }

LOCAL_NODE="$SCRIPT_DIR/node_runtime/node"
USE_NODE=""

echo ""
echo "  +==========================================+"
echo "  |        Gemini Relay Studio             |"
echo "  +==========================================+"
echo ""

# ── 1. 优先用本地缓存的便携版 ────────────────────────────
if [ -x "$LOCAL_NODE" ]; then
    USE_NODE="$LOCAL_NODE"
    info "使用本地缓存 Node.js ✓"
fi

# ── 2. 检查系统 Node.js ──────────────────────────────────
if [ -z "$USE_NODE" ] && command -v node &>/dev/null; then
    NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
    if [ "$NODE_MAJOR" -ge 24 ]; then
        info "系统 Node.js $(node --version) ✓"
        USE_NODE="node"
    else
        warn "系统 Node.js 版本过低（v$NODE_MAJOR，需要 v24+），将自动下载便携版。"
    fi
fi

# ── 3. 自动下载便携版 ────────────────────────────────────
if [ -z "$USE_NODE" ]; then
    if ! command -v curl &>/dev/null; then
        error "未找到 curl，无法自动下载。请先安装 Node.js 24："
        echo "  https://nodejs.org/zh-cn/download"
        exit 1
    fi

    info "正在获取 Node.js 最新版本信息..."
    NODE_VER=$(curl -fsSL "https://nodejs.org/dist/index.json" \
        | grep -o '"version":"v24\.[^"]*"' | head -1 \
        | grep -o 'v24\.[0-9.]*')

    if [ -z "$NODE_VER" ]; then
        error "无法获取 Node.js 版本信息，请检查网络后重试。"
        exit 1
    fi

    # 检测架构
    ARCH=$(uname -m)
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
        NODE_ARCH="arm64"
    else
        NODE_ARCH="x64"
    fi

    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    if [ "$OS" = "darwin" ]; then
        PLATFORM="darwin"
    else
        PLATFORM="linux"
    fi

    TARBALL="node-${NODE_VER}-${PLATFORM}-${NODE_ARCH}.tar.gz"
    DOWNLOAD_URL="https://nodejs.org/dist/${NODE_VER}/${TARBALL}"
    RUNTIME_DIR="$SCRIPT_DIR/node_runtime"

    info "下载 Node.js ${NODE_VER} (${PLATFORM}-${NODE_ARCH})，约 30MB，请稍候..."
    mkdir -p "$RUNTIME_DIR"
    TMPFILE="$RUNTIME_DIR/_node_download.tar.gz"

    curl -fL --progress-bar "$DOWNLOAD_URL" -o "$TMPFILE"
    info "解压中..."
    tar -xzf "$TMPFILE" -C "$RUNTIME_DIR" --strip-components=2 \
        "node-${NODE_VER}-${PLATFORM}-${NODE_ARCH}/bin/node"
    rm -f "$TMPFILE"
    chmod +x "$LOCAL_NODE"

    success "Node.js ${NODE_VER} 已就绪！"
    USE_NODE="$LOCAL_NODE"
fi

# ── 4. 首次运行创建 .env ─────────────────────────────────
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp ".env.example" ".env"
    echo ""
    warn "════════════════════════════════════════════════════"
    warn " 首次运行：请在浏览器左侧【接口配置】面板填入："
    warn "   • OneAPI 地址"
    warn "   • OneAPI Key（sk-...）"
    warn " 点击【保存并启用】即可开始使用。"
    warn "════════════════════════════════════════════════════"
    echo ""
fi

# ── 5. 读取端口 ──────────────────────────────────────────
PORT=4310
if [ -f ".env" ]; then
    ENV_PORT=$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]"'"'" || true)
    if [[ -n "${ENV_PORT:-}" && "$ENV_PORT" =~ ^[0-9]+$ ]]; then
        PORT="$ENV_PORT"
    fi
fi

# ── 6. 启动服务 ──────────────────────────────────────────
info "启动工作台...（按 Ctrl+C 停止）"
info "工作台地址：http://localhost:${PORT}"
echo ""

# macOS 自动打开浏览器
if [[ "${OSTYPE:-}" == "darwin"* ]]; then
    (sleep 1.5 && open "http://localhost:${PORT}") &
fi

exec "$USE_NODE" --no-warnings server/index.js
