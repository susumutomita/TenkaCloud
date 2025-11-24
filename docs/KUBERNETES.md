# TenkaCloud Kubernetes Deployment Guide

This guide describes how to deploy TenkaCloud to a Kubernetes cluster.

## Prerequisites

- Kubernetes cluster (e.g., Docker Desktop, Minikube, Kind, or a cloud provider)
- `kubectl` configured to talk to your cluster
- `docker` (for building images)
- `/etc/hosts` entry for Keycloak (see below)

## 0. Setup Kubernetes Cluster

### Docker Desktop (最新版)

最新の Docker Desktop では、Kubernetesクラスターを作成する方式に変更されています：

1. **Docker Desktop を起動**
   ```bash
   open -a Docker
   ```

2. **Kubernetesクラスターを作成**
   - 左メニュー > **Kubernetes** を選択
   - **"Start a Kubernetes cluster"** または **"Create"** をクリック
   - ダイアログで：
     - ✅ **Kubeadm** を選択（シングルノードクラスター、推奨）
     - **Create** ボタンをクリック

3. **作成完了を待つ**（3〜5分）
   - Docker Desktopのステータスで進捗確認

4. **クラスター確認**
   ```bash
   # コンテキスト一覧確認
   kubectl config get-contexts

   # kubeadm コンテキストに切り替え
   kubectl config use-context kubeadm

   # クラスター接続確認
   kubectl cluster-info
   ```

5. **TenkaCloudデプロイ前の確認**
   ```bash
   make check-k8s
   ```

### Docker Desktop (従来版)

従来のDocker Desktopを使用している場合：

1. メニューバー > Docker 🐳 > **Settings**
2. **Kubernetes** > ☑️ **Enable Kubernetes**
3. **Apply & Restart**

### その他の環境

- **Minikube**: `minikube start`
- **Kind**: `kind create cluster`
- **Cloud (EKS/GKE/AKS)**: 各クラウドプロバイダーのドキュメント参照

## 1. Build Docker Images

Since we are deploying locally, we need to build the images first.

```bash
make k8s-build-all
```

If you are using Minikube or Kind, you might need to load the images into the cluster or point your Docker CLI to the cluster's Docker daemon.
- Minikube: `eval $(minikube docker-env)` before building.
- Kind: `kind load docker-image tenkacloud/control-plane-ui:latest ...`

## 2. Configure Local DNS

To ensure that the browser and the internal services can communicate with Keycloak using the same hostname, add the following entry to your `/etc/hosts` file:

```
127.0.0.1 keycloak
```

## 3. Deploy to Kubernetes

```bash
make k8s-deploy
```

This command will apply the manifests in `infrastructure/k8s`.

## 4. Setup Keycloak

After deployment, you need to configure Keycloak.
First, port-forward the Keycloak service:

```bash
kubectl port-forward svc/keycloak 8080:8080 -n tenkacloud
```

Then, in a separate terminal, run the setup script:

```bash
./infrastructure/docker/keycloak/scripts/setup-keycloak.sh
```

## 5. Access Applications

You can access the applications by port-forwarding them:

```bash
# Control Plane UI
kubectl port-forward svc/control-plane-ui 3000:3000 -n tenkacloud

# Admin App
kubectl port-forward svc/admin-app 3001:3001 -n tenkacloud

# Participant App
kubectl port-forward svc/participant-app 3002:3002 -n tenkacloud

# Landing Site
kubectl port-forward svc/landing-site 3003:3003 -n tenkacloud
```

Access them at:
- Control Plane UI: http://localhost:3000
- Admin App: http://localhost:3001
- Participant App: http://localhost:3002
- Landing Site: http://localhost:3003
- Keycloak: http://keycloak:8080 (or http://localhost:8080)

## Troubleshooting

- **ImagePullBackOff**: Ensure the images are built and available to the cluster. If using Docker Desktop, local images should work. If using Minikube/Kind, load them.
- **Keycloak Connection Refused**: Ensure port-forwarding is running and `/etc/hosts` is configured.
