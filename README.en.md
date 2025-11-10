# TenkaCloud — The Open Cloud Battle Arena

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

English | [日本語](./README.md)

## 🎯 Project Overview

TenkaCloud is an open-source, permanent competitive platform for cloud engineers. Rooted in AWS GameDay culture, it's being built from scratch as an OSS version of the Cloud Tenkaichi Budokai (Cloud Battle Arena) platform.

## 🏯 Concept

A permanent battle arena where cloud warriors from around the world gather to hone their skills, compete, and learn together.

### Core Values

- 🧱 **Fully OSS Implementation** — Redesigned from scratch without proprietary assets
- ☁️ **Multi-Cloud Support** — AWS / GCP / Azure / LocalStack / OCI
- 🏗 **Multi-Tenant SaaS Architecture** — Permanent, team battles, spectator mode
- ⚔️ **Problem Compatibility** — Reuse existing Cloud Contest problems
- 🧠 **AI-Powered Features** — Problem generation, auto-grading, coaching (MCP/Claude Code support)

## 🚀 Key Features

### 1. Battle Arena

- Real-time battle sessions
- Team battle mode
- Spectator mode (real-time progress display)
- Battle history and replay

### 2. Problem Management

- Problem library
- Problem creation and editing (AI-assisted)
- Compatible with Open Cloud Contest format
- Custom problem creation

### 3. Auto-Grading System

- Automated infrastructure validation
- Cost optimization scoring
- Security evaluation
- Performance evaluation
- Detailed feedback

### 4. AI-Powered Features

- **Problem Generation**: AI-powered automatic problem creation
- **Auto-Grading**: Automated infrastructure evaluation
- **Coaching**: Real-time hints and advice
- **MCP/Claude Code Integration**: Enhanced developer experience

### 5. Multi-Tenant Management

- Tenant registration and management
- Resource isolation
- Usage tracking
- Billing management (future implementation)

### 6. Leaderboard

- Global rankings
- Category-based rankings
- Team rankings
- Statistics

## 🛠 Technology Stack

### Frontend

- **Next.js** (App Router) - Main framework
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **React** - UI framework

### Backend

- **AWS EKS** - Kubernetes cluster
- **Multi-Tenant Architecture** - Tenant isolation and resource management
- **Microservices** - Scalable service design

### Infrastructure

- **Kubernetes** - Container orchestration
- **Docker** - Containerization
- **Terraform** - Multi-cloud support

### AI/ML

- **Claude API** - AI-powered features
- **MCP (Model Context Protocol)** - AI integration
- **Auto-Grading System** - Automated infrastructure evaluation

## 🏗 Project Structure

```text
TenkaCloud/
├── frontend/              # Next.js application
│   ├── app/              # App Router
│   ├── components/       # React components
│   ├── lib/              # Utilities
│   └── styles/           # Styles
├── backend/              # Backend services
│   ├── api/              # API service
│   ├── auth/             # Authentication service
│   ├── tenant/           # Tenant management
│   ├── battle/           # Battle management
│   └── scoring/          # Scoring system
├── infrastructure/       # Infrastructure code
│   ├── k8s/              # Kubernetes manifests
│   └── terraform/        # Terraform (multi-cloud)
├── problems/             # Problem definitions
│   ├── templates/        # Problem templates
│   └── examples/         # Sample problems
├── ai/                   # AI features
│   ├── problem-generator/ # Problem generation
│   ├── scoring/          # Auto-grading
│   └── coaching/         # Coaching features
└── docs/                 # Documentation
```

## 🚦 Development Setup

### Requirements

- Node.js 18+
- Bun (recommended) or npm
- Docker & Docker Compose
- kubectl
- Terraform (optional)

### Local Development

```bash
# Clone the repository
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud

# Install dependencies
bun install
# or
npm install

# Start development server
bun run dev
# or
npm run dev
```

### Running Tests

```bash
# Run tests
bun run test

# Run tests with coverage
bun run test:coverage

# Run linter
bun run lint
make lint_text

# Check formatting
make format_check
```

## 📖 Documentation

- [Development Guide](./CLAUDE.md) - Developer playbook for Claude Code/AI agents
- [Architecture Design](./docs/architecture.md) (planned)
- [API Documentation](./docs/api.md) (planned)

## 🤝 Contributing

This project is fully open-source. Contributions are welcome!

1. Create an Issue for feature proposals or bug reports
2. Fork and create a branch
3. Commit your changes
4. Submit a Pull Request

### Coding Standards

- TypeScript strict mode
- ESLint + Prettier
- Component-driven development
- Test-driven development (TDD)

## 📄 License

MIT License (planned)

## 🔮 Roadmap

### Phase 1: Foundation

- [ ] Next.js project setup
- [ ] AWS EKS cluster setup
- [ ] Basic multi-tenant structure
- [ ] Authentication and authorization system

### Phase 2: Core Features

- [ ] Battle arena features
- [ ] Problem management system
- [ ] Basic scoring system

### Phase 3: AI Integration

- [ ] AI problem generation
- [ ] Auto-grading system
- [ ] Coaching features

### Phase 4: Multi-Cloud Support

- [ ] GCP support
- [ ] Azure support
- [ ] OCI support
- [ ] LocalStack integration

### Phase 5: Advanced Features

- [ ] Spectator mode
- [ ] Leaderboard
- [ ] Statistics and analytics

## 🎓 References

- [AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)
- [Kubernetes Official Documentation](https://kubernetes.io/docs/)
- [Next.js Official Documentation](https://nextjs.org/docs)

## 📞 Contact

- GitHub Issues: Feature proposals and bug reports
- Discussions: Technical discussions

---

*Built with ❤️ by the TenkaCloud community*
