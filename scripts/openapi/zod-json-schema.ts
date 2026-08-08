import { type ZodTypeAny, z } from "zod";

/**
 * Issue #2949: zod v3 schema を OpenAPI 3.1 が受け付ける JSON Schema へ変換する最小 converter。
 *
 * ## なぜ自前で書くのか
 *
 * このリポジトリの handler は zod v3 で書かれている。`zod/v4` の `toJSONSchema` は v4 で作った
 * schema しか受け付けず (`schema._zod.def` を読むため v3 を渡すと即 throw する)、変換用の外部
 * package を足すのは supply-chain 判断になる。実際に使われている構文は object / string / number /
 * boolean / enum / literal / array / optional / nullable / union の 10 種類しかないので、その範囲
 * だけを自前で扱う。
 *
 * ## 未対応の型は握り潰さず throw する
 *
 * 知らない型に出会ったら `{}` を返して「何でも通る schema」を吐くのが最悪の失敗である。生成物は
 * 公開 API リファレンスになるので、それは嘘のドキュメントを配ることになる。よって
 * `UnsupportedZodTypeError` を投げて生成そのものを止める。新しい構文を使いたくなったらここに
 * 明示的に足す。
 */

export class UnsupportedZodTypeError extends Error {
  constructor(
    public readonly typeName: string,
    public readonly path: string,
  ) {
    super(
      `zod type "${typeName}" は OpenAPI 変換に未対応です (path: ${path || "<root>"})。` +
        `scripts/openapi/zod-json-schema.ts に変換を追加してください。`,
    );
    this.name = "UnsupportedZodTypeError";
  }
}

/** JSON Schema の `enum` / `const` に載る scalar。 */
export type JsonSchemaScalar = string | number | boolean;

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly JsonSchemaScalar[];
  const?: JsonSchemaScalar;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  description?: string;
}

const Kind = z.ZodFirstPartyTypeKind;

interface StringCheck {
  readonly kind: string;
  readonly value?: number;
  readonly regex?: RegExp;
}

function applyStringChecks(schema: JsonSchema, checks: readonly StringCheck[]): void {
  for (const check of checks) {
    if (check.kind === "min" && typeof check.value === "number") schema.minLength = check.value;
    if (check.kind === "max" && typeof check.value === "number") schema.maxLength = check.value;
    // JSON Schema の `pattern` は ECMA-262 部分集合。既存 regex は anchor 付きの単純な形なので
    // source をそのまま載せる (flags は使われていない)。
    if (check.kind === "regex" && check.regex) schema.pattern = check.regex.source;
  }
}

function applyNumberChecks(schema: JsonSchema, checks: readonly StringCheck[]): void {
  for (const check of checks) {
    if (check.kind === "min" && typeof check.value === "number") schema.minimum = check.value;
    if (check.kind === "max" && typeof check.value === "number") schema.maximum = check.value;
    if (check.kind === "int") schema.type = "integer";
  }
}

/** zod schema を JSON Schema へ変換する。未対応型は throw する (fail-loud)。 */
export function zodToJsonSchema(schema: ZodTypeAny, path = ""): JsonSchema {
  const def: { typeName?: string } = schema._def;
  const typeName = def.typeName ?? "unknown";

  switch (typeName) {
    case Kind.ZodString: {
      const out: JsonSchema = { type: "string" };
      const checks: readonly StringCheck[] =
        (schema._def as { checks?: readonly StringCheck[] }).checks ?? [];
      applyStringChecks(out, checks);
      return out;
    }
    case Kind.ZodNumber: {
      const out: JsonSchema = { type: "number" };
      const checks: readonly StringCheck[] =
        (schema._def as { checks?: readonly StringCheck[] }).checks ?? [];
      applyNumberChecks(out, checks);
      return out;
    }
    case Kind.ZodBoolean:
      return { type: "boolean" };
    case Kind.ZodEnum: {
      const values: readonly string[] = (schema._def as { values: readonly string[] }).values;
      return { type: "string", enum: [...values] };
    }
    case Kind.ZodLiteral: {
      const value = (schema._def as { value: JsonSchemaScalar }).value;
      return { type: typeof value, const: value };
    }
    case Kind.ZodArray: {
      const inner = (schema._def as { type: ZodTypeAny }).type;
      return { type: "array", items: zodToJsonSchema(inner, `${path}[]`) };
    }
    case Kind.ZodOptional:
    case Kind.ZodNullable: {
      const inner = (schema._def as { innerType: ZodTypeAny }).innerType;
      const converted = zodToJsonSchema(inner, path);
      if (typeName === Kind.ZodNullable) {
        converted.type = converted.type === undefined ? "null" : [String(converted.type), "null"];
      }
      return converted;
    }
    case Kind.ZodUnion: {
      const options: readonly ZodTypeAny[] = (schema._def as { options: readonly ZodTypeAny[] })
        .options;
      return {
        anyOf: options.map((option, index) => zodToJsonSchema(option, `${path}|${index}`)),
      };
    }
    case Kind.ZodObject:
      return objectToJsonSchema(schema, path);
    default:
      throw new UnsupportedZodTypeError(typeName, path);
  }
}

function objectToJsonSchema(schema: ZodTypeAny, path: string): JsonSchema {
  const shapeFactory = (schema._def as { shape: () => Record<string, ZodTypeAny> }).shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shapeFactory())) {
    properties[key] = zodToJsonSchema(value, path ? `${path}.${key}` : key);
    if (!value.isOptional()) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  return out;
}
