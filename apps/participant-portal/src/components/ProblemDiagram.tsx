import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Link from "@cloudscape-design/components/link";
import { useState } from "react";

export function ProblemDiagram({ src, t }: { src: string; t: (key: string) => string }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure style={{ margin: 0 }}>
      <figcaption>
        <Box variant="awsui-key-label">{t("problem_detail.info_diagram_label")}</Box>
      </figcaption>
      {failed ? (
        <Alert type="warning">
          {t("problem_detail.info_diagram_failed")}{" "}
          <Link href={src} external>
            {t("problem_detail.info_diagram_open")}
          </Link>
        </Alert>
      ) : (
        <img
          src={src}
          alt={t("problem_detail.info_diagram_alt")}
          onError={() => setFailed(true)}
          style={{ maxWidth: "100%", height: "auto" }}
        />
      )}
    </figure>
  );
}
