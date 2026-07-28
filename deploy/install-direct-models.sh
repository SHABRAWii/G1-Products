#!/usr/bin/env bash
# Install the two model engines used by RoboMotion. This script never clones,
# invokes, or depends on a pipeline wrapper repository.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_ROOT="${ROBOMOTION_MODEL_ROOT:-$PROJECT_ROOT/.robomotion}"
SOURCE_ROOT="${ROBOMOTION_MODEL_SOURCES:-$MODEL_ROOT/sources}"
MODEL_CACHE="${ROBOMOTION_MODEL_CACHE:-$MODEL_ROOT/cache}"
PHMR_DIR="${ROBOMOTION_PROMPTHMR_ROOT:-$SOURCE_ROOT/PromptHMR}"
GMR_DIR="${ROBOMOTION_GMR_ROOT:-$SOURCE_ROOT/GMR}"
PHMR_ENV="${ROBOMOTION_PROMPTHMR_ENV:-phmr_pt2.4}"
GMR_ENV="${ROBOMOTION_GMR_ENV:-gmr}"
TRAIN_ENV="${ROBOMOTION_TRAIN_ENV:-train}"
PROMPTHMR_REF="${ROBOMOTION_PROMPTHMR_REF:-4f8915c5b9603344c56e95fadb9a01a23ba2272d}"
GMR_REF="${ROBOMOTION_GMR_REF:-069b4fd48f440e813b2b4d69255c70f53e5f83fb}"
# Latest genuine upstream commit on unitreerobotics/unitree_rl_mjlab's main
# branch as of this pin (verified via `git fetch origin`), not any fork.
TRAIN_REF="${ROBOMOTION_TRAIN_REF:-1425b15f73bd4095f0df53709d7c389c3eb9e790}"
TRAIN_DIR="${ROBOMOTION_TRAIN_ROOT:-$SOURCE_ROOT/unitree_rl_mjlab}"
TRAIN_PATCH="$PROJECT_ROOT/deploy/patches/unitree_rl_mjlab-robomotion.patch"
LOG_DIR="$MODEL_ROOT/install-logs"
CHECKPOINT_MARKER="$MODEL_CACHE/prompthmr-data/.robomotion-checkpoints-v1"
CHECKSUM_MANIFEST="$MODEL_CACHE/prompthmr-data/.robomotion-checksums-v1.sha256"
INTERACTIVE=false
[[ -t 1 && -z "${NO_COLOR:-}" ]] && INTERACTIVE=true
STAGE_NUMBER=0
CACHED_STAGE_COUNT=0
CACHED_STAGE_LATEST=""

if $INTERACTIVE; then
  BLUE=$'\033[38;5;39m'; GREEN=$'\033[38;5;42m'; AMBER=$'\033[38;5;214m'; RED=$'\033[38;5;203m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  BLUE=''; GREEN=''; AMBER=''; RED=''; DIM=''; BOLD=''; RESET=''
fi

fail() { printf '%sERROR:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

stage_insight() {
  local title="$1" elapsed="${2:-0}"
  case "$title" in
    *"Synchronizing"*) printf '%s' "Sources are pinned to explicit upstream commits for reproducible installs." ;;
    *"PyTorch"*) printf '%s' "CUDA wheels are large; the installer keeps raw pip output in a stage log." ;;
    *"world-video"*) printf '%s' "These are PromptHMR's compiled inference wheels, not RoboMotion code." ;;
    *"model bundle"*)
      if (( elapsed < 20 )); then printf '%s' "PromptHMR is reading its published Google Drive folder metadata.";
      elif (( elapsed < 120 )); then printf '%s' "Large support assets are saved in the persistent model cache as they arrive.";
      else printf '%s' "The bundle contains checkpoints, annotations, support assets, and examples; this is expected to take time."; fi ;;
    *"SHA-256"*) printf '%s' "RoboMotion hashes cached files locally to detect later corruption before reuse." ;;
    *"licensed body"*) printf '%s' "Credentials are read only from your local restricted secret files." ;;
    *"Verifying model"*) printf '%s' "The final check imports both engines using the direct source installations." ;;
    *) printf '%s' "Only missing or invalid prerequisites are installed." ;;
  esac
}

stage_telemetry() {
  case "$1" in
    *"model bundle"*|*"world-video"*)
      local directory="$MODEL_CACHE/prompthmr-data"
      [[ -d "$directory" ]] || return
      local files size
      files="$(find "$directory" -type f 2>/dev/null | wc -l | tr -d ' ')"
      size="$(du -sh "$directory" 2>/dev/null | awk '{print $1}')"
      printf '%s assets · %s cached' "$files" "${size:-0B}"
      ;;
  esac
}

render_stage() {
  local title="$1" detail="$2"
  if $INTERACTIVE; then printf '\033[2J\033[H'; fi
  printf '%s%sROBO MOTION  ·  DIRECT MODEL INSTALL%s\n' "$BOLD" "$BLUE" "$RESET"
  printf '%s────────────────────────────────────────────────────────────%s\n' "$DIM" "$RESET"
  printf '%sSTEP %02d%s  %s%s%s\n' "$AMBER" "$STAGE_NUMBER" "$RESET" "$BOLD" "$title" "$RESET"
  printf '%s%s%s\n\n' "$DIM" "$detail" "$RESET"
  if (( CACHED_STAGE_COUNT > 0 )); then
    printf '%sCACHE REUSE%s  %d verified component(s) · latest: %s\n\n' "$GREEN" "$RESET" "$CACHED_STAGE_COUNT" "$CACHED_STAGE_LATEST"
  fi
  # Reserve two terminal lines. The spinner and insight below replace only
  # these lines instead of appending status text to the terminal.
  printf '\n\n'
}

run_stage() {
  local title="$1" detail="$2"; shift 2
  local slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  local log="$LOG_DIR/$(printf '%02d' "$STAGE_NUMBER")-${slug}.log"
  ((STAGE_NUMBER += 1))
  render_stage "$title" "$detail"
  "$@" >"$log" 2>&1 &
  local pid=$! spinner='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' index=0 elapsed=0 telemetry=''
  while kill -0 "$pid" 2>/dev/null; do
    if (( elapsed % 5 == 0 )); then telemetry="$(stage_telemetry "$title")"; fi
    if $INTERACTIVE; then
      printf '\033[2A\r\033[K%s  %s%s  %sworking · %02dm %02ds%s%s\n\033[K%sⓘ%s %s\n' "$BLUE" "${spinner:index++%${#spinner}:1}" "$RESET" "$DIM" "$((elapsed / 60))" "$((elapsed % 60))" "$RESET" "${telemetry:+ · $telemetry}" "$BLUE" "$RESET" "$(stage_insight "$title" "$elapsed")"
    fi
    sleep 1
    ((elapsed += 1))
  done
  if wait "$pid"; then
    if $INTERACTIVE; then printf '\033[2A\r\033[K%s  ✓%s  %scomplete in %02dm %02ds%s\n\033[K' "$GREEN" "$RESET" "$DIM" "$((elapsed / 60))" "$((elapsed % 60))" "$RESET"; sleep 0.7; else printf '✓ %s complete\n' "$title"; fi
  else
    local code=$?
    printf '\n%s%s failed%s. Full log: %s\n\n' "$BOLD" "$title" "$RESET" "$log" >&2
    tail -80 "$log" >&2 || true
    exit "$code"
  fi
}

cached_stage() {
  local title="$1" detail="$2"
  ((STAGE_NUMBER += 1))
  ((CACHED_STAGE_COUNT += 1))
  CACHED_STAGE_LATEST="$title"
  render_stage "Reusing $title" "$detail"
  if $INTERACTIVE; then
    printf '\033[2A\r\033[K%s  ✓%s  %sCACHE VERIFIED · no download or installation required%s\n\033[K' "$GREEN" "$RESET" "$DIM" "$RESET"
    sleep 0.8
  else
    printf '✓ %s cache verified\n' "$title"
  fi
}

read_secret() {
  local name file_var value file
  name="$1"
  file_var="${name}_FILE"
  value=""
  file=""
  if [[ -v "$name" ]]; then value="${!name}"; fi
  if [[ -v "$file_var" ]]; then file="${!file_var}"; fi
  if [[ -n "$file" ]]; then [[ -r "$file" ]] || fail "$file_var is not readable: $file"; value="$(<"$file")"; fi
  printf '%s' "$value"
}

clone_at_ref() {
  local name="$1" url="$2" destination="$3" ref="$4"
  if [[ ! -d "$destination/.git" ]]; then git clone "$url" "$destination"; fi
  git -C "$destination" fetch --tags origin
  git -C "$destination" checkout --detach "$ref"
  git -C "$destination" submodule update --init --recursive
}

sync_sources() {
  clone_at_ref "GMR" "https://github.com/taeyoun811/GMR.git" "$GMR_DIR" "$GMR_REF"
  clone_at_ref "PromptHMR" "https://github.com/taeyoun811/PromptHMR.git" "$PHMR_DIR" "$PROMPTHMR_REF"
  clone_at_ref "unitree_rl_mjlab" "https://github.com/unitreerobotics/unitree_rl_mjlab.git" "$TRAIN_DIR" "$TRAIN_REF"
}

# The patch adds a required setup.py dependency fix plus the best-checkpoint
# feature (see the patch file's own header for details). Idempotent: detects
# "already applied" (via a clean reverse-apply) versus a real mismatch, so
# re-running the installer never fails or double-applies, and a genuine
# upstream change to these files fails loudly instead of silently skipping
# the feature.
train_patch_applied() {
  git -C "$TRAIN_DIR" apply --reverse --check "$TRAIN_PATCH" >/dev/null 2>&1
}
apply_train_patch() {
  if train_patch_applied; then return 0; fi
  git -C "$TRAIN_DIR" apply --check "$TRAIN_PATCH" 2>/dev/null \
    || fail "The RoboMotion unitree_rl_mjlab patch ($TRAIN_PATCH) does not apply cleanly to $TRAIN_REF. unitree_rl_mjlab has likely changed upstream since this was pinned; regenerate the patch against the new commit rather than forcing it."
  git -C "$TRAIN_DIR" apply "$TRAIN_PATCH"
}

conda_environment_exists() {
  conda env list --json | python -c "import json,sys; print(any(p.endswith('/$1') for p in json.load(sys.stdin)['envs']))" | grep -qx True
}

persist_directory() {
  local source="$1" destination="$2"
  mkdir -p "$destination"
  if [[ -L "$source" ]]; then return; fi
  if [[ -e "$source" ]]; then cp -a "$source/." "$destination/"; rm -rf "$source"; fi
  ln -s "$destination" "$source"
}

prepare_persistence() {
  persist_directory "$PHMR_DIR/data" "$MODEL_CACHE/prompthmr-data"
  persist_directory "$GMR_DIR/assets/body_models" "$MODEL_CACHE/gmr-body-models"
}

install_gmr() {
  if ! conda_environment_exists "$GMR_ENV"; then conda create -n "$GMR_ENV" python=3.10 -c conda-forge -y; fi
  if ! conda run -n "$GMR_ENV" python -m pip --version >/dev/null 2>&1; then conda run -n "$GMR_ENV" python -m ensurepip --upgrade; fi
  if ! conda run -n "$GMR_ENV" python -c 'import general_motion_retargeting' >/dev/null 2>&1; then conda run -n "$GMR_ENV" python -m pip install -e "$GMR_DIR"; fi
}

install_digital_twin_renderer() {
  conda run -n "$GMR_ENV" python -m pip install \
    trimesh==4.10.0 \
    pyglet==1.5.31 \
    freetype-py==2.5.1 \
    six==1.17.0
  # Keep the modern PyOpenGL installed with MuJoCo; pyrender's old strict pin is incompatible.
  conda run -n "$GMR_ENV" python -m pip install pyrender==0.1.45 --no-deps
}

install_train_base() {
  if ! conda_environment_exists "$TRAIN_ENV"; then conda create -n "$TRAIN_ENV" python=3.11.9 -c conda-forge -y; fi
  conda_environment_exists "$TRAIN_ENV" || fail "Conda did not create $TRAIN_ENV."
  if ! conda run -n "$TRAIN_ENV" python -m pip --version >/dev/null 2>&1; then conda run -n "$TRAIN_ENV" python -m ensurepip --upgrade; fi
}
# Pinned to the exact CUDA build verified against this project's training
# stage. mjlab's own bare `torch>=2.7.0` requirement has no default index, so
# leaving this to a plain `pip install -e .` risks resolving a different
# torch/CUDA build on a future install; pinning it explicitly first (same
# pattern as install_pytorch below for PromptHMR) keeps it reproducible.
install_train_pytorch() { conda run -n "$TRAIN_ENV" python -m pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cu130; }
install_unitree_rl_mjlab() { conda run -n "$TRAIN_ENV" python -m pip install -e "$TRAIN_DIR"; }

install_prompthmr_base() {
  if ! conda_environment_exists "$PHMR_ENV"; then conda create -n "$PHMR_ENV" python=3.11.9 -c conda-forge -y; fi
  conda_environment_exists "$PHMR_ENV" || fail "Conda did not create $PHMR_ENV."
  if ! conda run -n "$PHMR_ENV" python -m pip --version >/dev/null 2>&1; then conda run -n "$PHMR_ENV" python -m ensurepip --upgrade; fi
}

install_pytorch() { conda run -n "$PHMR_ENV" python -m pip install torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0 --index-url https://download.pytorch.org/whl/cu121; }
install_torch_scatter() { conda run -n "$PHMR_ENV" python -m pip install torch-scatter -f https://data.pyg.org/whl/torch-2.4.0+cu121.html; }
install_requirements() { conda install -n "$PHMR_ENV" -c conda-forge suitesparse -y && conda run -n "$PHMR_ENV" python -m pip install --upgrade setuptools pip && conda run -n "$PHMR_ENV" python -m pip install -r "$PHMR_DIR/requirements.txt"; }
install_chumpy() { conda run -n "$PHMR_ENV" python -m pip install -e "$PHMR_DIR/python_libs/chumpy" --no-build-isolation; }
install_xformers() { conda run -n "$PHMR_ENV" python -m pip install xformers==0.0.27.post2 --no-deps; }
download_support_wheels() { (cd "$PHMR_DIR" && conda run -n "$PHMR_ENV" gdown --folder -O ./data/ 'https://drive.google.com/drive/folders/1IXyhVqL25ofI-tYqyUZCqF-h4V20795H?usp=sharing'); }
install_support_wheels() { for wheel in detectron2-0.8-cp311-cp311-linux_x86_64.whl droid_backends_intr-0.3-cp311-cp311-linux_x86_64.whl lietorch-0.3-cp311-cp311-linux_x86_64.whl sam2-1.5-cp311-cp311-linux_x86_64.whl; do [[ -f "$PHMR_DIR/data/wheels/$wheel" ]] || fail "PromptHMR support wheel was not downloaded: $wheel"; conda run -n "$PHMR_ENV" python -m pip install "$PHMR_DIR/data/wheels/$wheel"; done; }
world_video_support_installed() { conda run -n "$PHMR_ENV" python -m pip show detectron2 droid_backends_intr lietorch sam2 >/dev/null 2>&1; }
required_checkpoint_paths() {
  cat <<'EOF'
pretrain/phmr/checkpoint.ckpt
pretrain/phmr/config.yaml
pretrain/phmr_vid/prhmr_release_002.ckpt
pretrain/phmr_vid/prhmr_release_002.yaml
pretrain/sam2_ckpts/sam2_hiera_tiny.pt
pretrain/camcalib_sa_biased_l2.ckpt
pretrain/droidcalib.pth
pretrain/vitpose-h-coco_25.pth
pretrain/sam_vit_h_4b8939.pth
EOF
}
checkpoint_assets_present() {
  local relative
  while IFS= read -r relative; do [[ -s "$PHMR_DIR/data/$relative" ]] || return 1; done < <(required_checkpoint_paths)
}
download_missing_folder() {
  local required="$1" url="$2"
  [[ -s "$PHMR_DIR/data/$required" ]] || (cd "$PHMR_DIR" && conda run -n "$PHMR_ENV" gdown --continue --remaining-ok --folder -O ./data/pretrain/ "$url")
}
download_missing_file() {
  local required="$1" url="$2"
  [[ -s "$PHMR_DIR/data/$required" ]] || (cd "$PHMR_DIR" && conda run -n "$PHMR_ENV" gdown --continue --fuzzy -O "./data/$required" "$url")
}
download_checkpoints() {
  mkdir -p "$PHMR_DIR/data/pretrain"
  download_missing_folder "pretrain/phmr/checkpoint.ckpt" "https://drive.google.com/drive/folders/1EQ7arZz135T-WpxkS_K1R_hjZp3prh-y?usp=share_link"
  download_missing_folder "pretrain/phmr_vid/prhmr_release_002.ckpt" "https://drive.google.com/drive/folders/18SywG7Fc_iTfVNaikjHAZmy-A9I85eKv?usp=sharing"
  download_missing_folder "pretrain/sam2_ckpts/sam2_hiera_tiny.pt" "https://drive.google.com/drive/folders/1OKhTdL1QVFH3f4hbIEa7jLANx4azuPi1?usp=sharing"
  download_missing_file "pretrain/camcalib_sa_biased_l2.ckpt" "https://drive.google.com/file/d/1t4tO0OM5s8XDvAzPW-5HaOkQuV3dHBdO/view?usp=sharing"
  download_missing_file "pretrain/droidcalib.pth" "https://drive.google.com/file/d/14hgb59Jk2Pvfiqy4nntE7dUrcKgFmKSj/view?usp=sharing"
  download_missing_file "pretrain/vitpose-h-coco_25.pth" "https://drive.google.com/file/d/1ZprPoNXe_f9a9flr0RhS3XCJBfqhFSeE/view?usp=sharing"
  [[ -s "$PHMR_DIR/data/pretrain/sam_vit_h_4b8939.pth" ]] || wget -c -P "$PHMR_DIR/data/pretrain/" "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth"
  checkpoint_assets_present || fail "PromptHMR checkpoint bundle is still incomplete after the direct download attempt."
  touch "$CHECKPOINT_MARKER"
}
write_checkpoint_manifest() {
  checkpoint_assets_present || fail "Cannot hash an incomplete PromptHMR model bundle."
  (cd "$PHMR_DIR/data" && while IFS= read -r relative; do sha256sum "$relative"; done < <(required_checkpoint_paths)) > "$CHECKSUM_MANIFEST"
  touch "$CHECKPOINT_MARKER"
}
verify_checkpoint_manifest() {
  if [[ -f "$CHECKSUM_MANIFEST" ]]; then
    (cd "$PHMR_DIR/data" && sha256sum -c "$CHECKSUM_MANIFEST" >/dev/null)
  else
    write_checkpoint_manifest
  fi
}
checkpoints_downloaded() {
  if [[ -f "$CHECKSUM_MANIFEST" ]]; then verify_checkpoint_manifest; else checkpoint_assets_present; fi
}
urlencode() {
  local value="$1" char encoded='' hex i
  for ((i = 0; i < ${#value}; i++)); do
    char="${value:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) encoded+="$char" ;;
      *) printf -v hex '%%%02X' "'$char"; encoded+="$hex" ;;
    esac
  done
  printf '%s' "$encoded"
}
download_protected_archive() {
  local domain="$1" filename="$2" destination="$3" username="$4" password="$5" request_file status
  [[ -s "$destination" ]] && return 0
  mkdir -p "$(dirname "$destination")"
  request_file="$(mktemp "$MODEL_ROOT/.model-download-request.XXXXXX")"
  chmod 600 "$request_file"
  printf 'username=%s&password=%s' "$(urlencode "$username")" "$(urlencode "$password")" > "$request_file"
  set +e
  wget --post-file="$request_file" "https://download.is.tue.mpg.de/download.php?domain=$domain&sfile=$filename" -O "$destination" --no-check-certificate --continue
  status=$?
  set -e
  rm -f "$request_file"
  return "$status"
}
body_models_downloaded() {
  [[ -s "$PHMR_DIR/data/body_models/smplx/SMPLX_NEUTRAL.npz" || -s "$PHMR_DIR/data/body_models/smplx/SMPLX_NEUTRAL.pkl" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/smplx/SMPLX_FEMALE.npz" || -s "$PHMR_DIR/data/body_models/smplx/SMPLX_FEMALE.pkl" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/smplx/SMPLX_MALE.npz" || -s "$PHMR_DIR/data/body_models/smplx/SMPLX_MALE.pkl" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/smpl/SMPL_NEUTRAL.pkl" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/smpl/SMPL_FEMALE.pkl" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/smpl/SMPL_MALE.pkl" ]]
}
body_support_assets_downloaded() {
  [[ -s "$PHMR_DIR/data/body_models/smplx2smpl.pkl" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/smplx2smpl_joints.npy" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/J_regressor_h36m.npy" ]] &&
    [[ -s "$PHMR_DIR/data/body_models/smplx/SMPLX_neutral_array_f32_slim.npz" ]]
}
download_body_models() {
  local smplx_root="$PHMR_DIR/data/body_models/smplx" smpl_root="$PHMR_DIR/data/body_models/smpl"
  mkdir -p "$smplx_root" "$smpl_root"
  if [[ ! -s "$smplx_root/SMPLX_NEUTRAL.npz" && ! -s "$smplx_root/SMPLX_NEUTRAL.pkl" ]]; then
    download_protected_archive smplx models_smplx_v1_1.zip "$PHMR_DIR/data/body_models/smplx.zip" "$SMPLX_USERNAME" "$SMPLX_PASSWORD"
    unzip -qo "$PHMR_DIR/data/body_models/smplx.zip" -d "$smplx_root"
    mv "$smplx_root/models/smplx/"* "$smplx_root/"
    rm -rf "$smplx_root/models" "$PHMR_DIR/data/body_models/smplx.zip"
  fi
  if [[ ! -s "$smpl_root/SMPL_NEUTRAL.pkl" ]]; then
    download_protected_archive smpl SMPL_python_v.1.1.0.zip "$smpl_root/smpl.zip" "$SMPL_USERNAME" "$SMPL_PASSWORD"
    unzip -qo "$smpl_root/smpl.zip" -d "$smpl_root/smpl"
    mv "$smpl_root/smpl/SMPL_python_v.1.1.0/smpl/models/basicmodel_neutral_lbs_10_207_0_v1.1.0.pkl" "$smpl_root/SMPL_NEUTRAL.pkl"
    mv "$smpl_root/smpl/SMPL_python_v.1.1.0/smpl/models/basicmodel_f_lbs_10_207_0_v1.1.0.pkl" "$smpl_root/SMPL_FEMALE.pkl"
    mv "$smpl_root/smpl/SMPL_python_v.1.1.0/smpl/models/basicmodel_m_lbs_10_207_0_v1.1.0.pkl" "$smpl_root/SMPL_MALE.pkl"
    rm -rf "$smpl_root/smpl" "$smpl_root/smpl.zip"
  fi
  body_models_downloaded || fail "SMPL/SMPL-X body model download completed but required extracted files are missing."
}
download_body_support_assets() {
  if [[ ! -s "$PHMR_DIR/data/body_models/smplx2smpl.pkl" || ! -s "$PHMR_DIR/data/body_models/smplx2smpl_joints.npy" || ! -s "$PHMR_DIR/data/body_models/J_regressor_h36m.npy" ]]; then
    (cd "$PHMR_DIR" && conda run -n "$PHMR_ENV" gdown --folder --continue --remaining-ok -O ./data/ 'https://drive.google.com/drive/folders/1JU7CuU2rKkwD7WWjvSZJKpQFFk_Z6NL7?usp=share_link')
  fi
  if [[ ! -s "$PHMR_DIR/data/body_models/smplx/SMPLX_neutral_array_f32_slim.npz" ]]; then
    (cd "$PHMR_DIR" && conda run -n "$PHMR_ENV" gdown --continue --fuzzy -O ./data/body_models/smplx/ 'https://drive.google.com/file/d/1v9Qy7ZXWcTM8_a9K2nSLyyVrJMFYcUOk/view')
  fi
  body_support_assets_downloaded || fail "PromptHMR body-model support assets are incomplete after the public download attempt."
}
validate_installation() { ln -sfn "$PHMR_DIR/data/body_models/smplx" "$GMR_DIR/assets/body_models/smplx"; conda run -n "$GMR_ENV" python -c 'import general_motion_retargeting'; (cd "$PHMR_DIR" && conda run -n "$PHMR_ENV" python -c 'from pipeline.pipeline import Pipeline'); conda run -n "$TRAIN_ENV" python -c 'import mjlab'; [[ -f "$TRAIN_DIR/scripts/train.py" ]] || fail "unitree_rl_mjlab source is incomplete."; }

command -v git >/dev/null || fail "git is required."
command -v conda >/dev/null || fail "Conda is required. Install Miniconda or Anaconda first."
command -v ffmpeg >/dev/null || fail "ffmpeg is required."
command -v ffprobe >/dev/null || fail "ffprobe is required."
command -v unzip >/dev/null || fail "unzip is required."
umask 077
mkdir -p "$SOURCE_ROOT" "$MODEL_CACHE" "$LOG_DIR"

run_stage "Synchronizing direct model sources" "Pinned PromptHMR and GMR upstream repositories" sync_sources
run_stage "Preparing persistent model storage" "Models and checkpoints survive future installer runs" prepare_persistence
if ! conda run -n "$GMR_ENV" python -c 'import general_motion_retargeting' >/dev/null 2>&1; then run_stage "Installing GMR" "Robot retargeting engine and its Python dependencies" install_gmr; else cached_stage "GMR" "Direct retargeting package import passed"; fi
if ! conda run -n "$GMR_ENV" python -c 'import pyrender, trimesh; assert pyrender.__version__ == "0.1.45"; assert trimesh.__version__ == "4.10.0"' >/dev/null 2>&1; then run_stage "Installing digital-twin renderer" "Exact Unitree STL rendering for MP4 evidence" install_digital_twin_renderer; else cached_stage "digital-twin renderer" "Exact STL renderer imports and pinned versions passed"; fi
if ! train_patch_applied; then run_stage "Applying RoboMotion training patch" "setup.py dependency fix plus best-checkpoint tracking, on top of the pinned commit" apply_train_patch; else cached_stage "RoboMotion training patch" "Patch already applied to the pinned checkout"; fi
if conda_environment_exists "$TRAIN_ENV" && conda run -n "$TRAIN_ENV" python -m pip --version >/dev/null 2>&1; then cached_stage "training environment" "Python 3.11 and pip in $TRAIN_ENV"; else run_stage "Preparing training environment" "Python 3.11 and pip in $TRAIN_ENV" install_train_base; fi
if ! conda run -n "$TRAIN_ENV" python -c 'import torch; assert torch.__version__.startswith("2.13.")' >/dev/null 2>&1; then run_stage "Installing PyTorch CUDA 13.0" "Large GPU package download; this can take several minutes" install_train_pytorch; else cached_stage "PyTorch CUDA 13.0" "Installed version and CUDA wheel contract passed"; fi
if ! conda run -n "$TRAIN_ENV" python -c 'import mjlab' >/dev/null 2>&1; then run_stage "Installing unitree_rl_mjlab" "mjlab and its full dependency closure (verified: torch, rsl-rl-lib, wandb, tyro, tensorboard, trimesh, viser, and more)" install_unitree_rl_mjlab; else cached_stage "unitree_rl_mjlab" "Direct mjlab import passed"; fi
if conda_environment_exists "$PHMR_ENV" && conda run -n "$PHMR_ENV" python -m pip --version >/dev/null 2>&1; then cached_stage "PromptHMR environment" "Python 3.11 and pip in $PHMR_ENV"; else run_stage "Preparing PromptHMR environment" "Python 3.11 and pip in $PHMR_ENV" install_prompthmr_base; fi
if ! conda run -n "$PHMR_ENV" python -c 'import torch; assert torch.__version__.startswith("2.4.")' >/dev/null 2>&1; then run_stage "Installing PyTorch CUDA 12.1" "Large GPU package download; this can take several minutes" install_pytorch; else cached_stage "PyTorch CUDA 12.1" "Installed version and CUDA wheel contract passed"; fi
if ! conda run -n "$PHMR_ENV" python -c 'import torch_scatter' >/dev/null 2>&1; then run_stage "Installing torch-scatter" "GPU geometry operator for PromptHMR" install_torch_scatter; else cached_stage "torch-scatter" "GPU geometry operator import passed"; fi
if ! conda run -n "$PHMR_ENV" python -c 'import omegaconf, gdown, smplx' >/dev/null 2>&1; then run_stage "Installing PromptHMR requirements" "Python dependencies and SuiteSparse" install_requirements; else cached_stage "PromptHMR requirements" "Core dependency imports passed"; fi
if ! conda run -n "$PHMR_ENV" python -c 'import chumpy' >/dev/null 2>&1; then run_stage "Installing chumpy" "Legacy geometry dependency" install_chumpy; else cached_stage "chumpy" "Legacy geometry dependency import passed"; fi
if ! conda run -n "$PHMR_ENV" python -c 'import xformers' >/dev/null 2>&1; then run_stage "Installing xFormers" "Memory-efficient transformer kernels" install_xformers; else cached_stage "xFormers" "Transformer kernel import passed"; fi
if [[ ! -f "$PHMR_DIR/data/wheels/detectron2-0.8-cp311-cp311-linux_x86_64.whl" ]]; then run_stage "Downloading world-video support" "PromptHMR GPU support wheels from its published model drive" download_support_wheels; else cached_stage "world-video support download" "Published support wheels are present in persistent storage"; fi
if ! world_video_support_installed; then run_stage "Installing world-video support" "Detectron2, DROID, LIEtorch, and SAM2 wheels" install_support_wheels; else cached_stage "world-video support" "All four support wheel distributions are installed"; fi
if ! checkpoints_downloaded; then run_stage "Downloading PromptHMR model bundle" "Published checkpoints, annotations, support assets, and examples; several gigabytes" download_checkpoints; else cached_stage "PromptHMR model bundle" "Expected model assets are already present"; fi
run_stage "Verifying PromptHMR SHA-256 cache" "Create or verify the local integrity manifest before cache reuse" verify_checkpoint_manifest

SMPLX_USERNAME="$(read_secret SMPLX_USERNAME)"; SMPLX_PASSWORD="$(read_secret SMPLX_PASSWORD)"; SMPL_USERNAME="$(read_secret SMPL_USERNAME)"; SMPL_PASSWORD="$(read_secret SMPL_PASSWORD)"
if ! body_models_downloaded; then
  [[ -n "$SMPLX_USERNAME" && -n "$SMPLX_PASSWORD" && -n "$SMPL_USERNAME" && -n "$SMPL_PASSWORD" ]] || fail "SMPL/SMPL-X credentials are required. Set the four variables or their *_FILE equivalents, then run this script again."
  run_stage "Downloading licensed body models" "SMPL-X and SMPL model archives using the local secret files" download_body_models
else
  cached_stage "licensed SMPL/SMPL-X body models" "Both SMPL-X and SMPL extracted model sets are already present"
fi
if ! body_support_assets_downloaded; then
  run_stage "Downloading PromptHMR body support assets" "Public conversion matrices needed to produce valid SMPL-X motion" download_body_support_assets
else
  cached_stage "PromptHMR body support assets" "SMPL-X conversion and joint-regression assets are already present"
fi
run_stage "Verifying model engines" "Direct PromptHMR and GMR imports plus shared SMPL-X assets" validate_installation

ENV_FILE="$MODEL_ROOT/worker-models.env"
cat > "$ENV_FILE" <<EOF
export ROBOMOTION_PROMPTHMR_ROOT='$PHMR_DIR'
export ROBOMOTION_GMR_ROOT='$GMR_DIR'
export ROBOMOTION_TRAIN_ROOT='$TRAIN_DIR'
export ROBOMOTION_MODEL_CACHE='$MODEL_CACHE'
export ROBOMOTION_PROMPTHMR_ENV='$PHMR_ENV'
export ROBOMOTION_GMR_ENV='$GMR_ENV'
export ROBOMOTION_TRAIN_ENV='$TRAIN_ENV'
EOF
chmod 600 "$ENV_FILE"
if $INTERACTIVE; then printf '\033[2J\033[H'; fi
printf '%s%sINSTALLATION COMPLETE%s\n' "$BOLD" "$GREEN" "$RESET"
printf 'Load worker paths with: source %s\n' "$ENV_FILE"
printf 'Detailed stage logs: %s\n' "$LOG_DIR"
