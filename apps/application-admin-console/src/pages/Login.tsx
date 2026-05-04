import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useAuth } from "../auth/AuthProvider";

export function LoginPage() {
  const auth = useAuth();

  return (
    <Box margin={{ top: "xxxl" }} textAlign="center">
      <Container header={<Header variant="h1">Application Admin Console</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">
            テナント開発者としてサインインしてください。Cognito の Hosted UI に遷移します。
          </Box>
          <Button variant="primary" onClick={auth.login}>
            サインイン
          </Button>
        </SpaceBetween>
      </Container>
    </Box>
  );
}
