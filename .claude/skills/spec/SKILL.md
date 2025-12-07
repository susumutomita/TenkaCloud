---
name: spec
description: Write technical specifications in Open Web Docs format (MDN style). Use this skill when creating API documentation, function specs, or technical references.
---

This skill guides creation of technical specifications following the Open Web Docs format (MDN Web Docs style). Produces clear, structured documentation that developers can quickly scan and understand.

The user provides a feature, API, or function to document. They may include implementation details, constraints, or related context.

## Documentation Structure

Follow this structure for all specifications:

1. **Title & Overview**: Feature name as H1, followed by 1-2 sentence summary
2. **Syntax**: Code block showing function signature or usage pattern
3. **Parameters**: Table with name, type, required flag, and description
4. **Return Value**: Type and description of what's returned
5. **Exceptions**: Table of errors and their trigger conditions (if applicable)
6. **Description**: Detailed explanation of behavior, constraints, edge cases
7. **Examples**: Working code examples covering common and edge cases
8. **Specifications**: Links to related specs or standards (if applicable)
9. **Related**: Links to related documentation

## Template

```markdown
# 機能名

簡潔な概要説明（1-2 文）。

## 構文

\`\`\`typescript
functionName(param1: Type, param2?: Type): ReturnType
\`\`\`

## パラメータ

| 名前 | 型 | 必須 | 説明 |
|------|-----|------|------|
| `param1` | `Type` | Yes | パラメータの説明 |
| `param2` | `Type` | No | オプションパラメータの説明。デフォルト値: `defaultValue` |

## 戻り値

`ReturnType` — 戻り値の説明。

## 例外

| 例外 | 条件 |
|------|------|
| `ErrorType` | 発生条件の説明 |

## 説明

機能の詳細な説明。動作、制約、注意点など。

## 例

### 基本的な使用例

\`\`\`typescript
// コード例
const result = functionName('value');
\`\`\`

### エラーハンドリング

\`\`\`typescript
try {
  const result = functionName('invalid');
} catch (error) {
  // エラー処理
}
\`\`\`

## 仕様

| 仕様 | ステータス |
|------|----------|
| [仕様名](URL) | Draft / Living Standard |

## 関連情報

- [関連ドキュメント](./path/to/doc.md)
```

## Writing Guidelines

### Be Concise

- Lead with the most important information
- Use short sentences and active voice
- Avoid unnecessary qualifiers ("simply", "just", "easily")

### Be Precise

- Specify exact types, not vague descriptions
- Document all edge cases and error conditions
- Include default values for optional parameters

### Be Scannable

- Use tables for structured data (parameters, exceptions)
- Use code blocks for all code references
- Use consistent formatting throughout

### Code Examples

- Show minimal working examples
- Include both success and error handling cases
- Use TypeScript for type clarity when applicable
- Add brief comments only where logic isn't obvious

## Anti-Patterns to Avoid

- Verbose introductions that don't add value
- Missing parameter types or return types
- Examples without context or explanation
- Incomplete error documentation
- Inconsistent formatting between sections

## Output Format

Always output specifications in Markdown following the template structure. The documentation should be immediately usable without editing.
