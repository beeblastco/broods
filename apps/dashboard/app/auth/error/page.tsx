import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";

// Where /auth/callback lands when its one automatic retry also failed. The
// error itself only reaches the server log, so the page carries no ref.
// /auth/sign-in is a route handler, so a plain GET form does a full navigation.
export default function SignInError(): React.JSX.Element {
  return (
    <StatusPage
      title="Sign-in failed"
      description="Your sign-in could not be completed."
      error={null}
    >
      <form action="/auth/sign-in" method="get">
        <Button type="submit" className="cursor-pointer">
          Sign in again
        </Button>
      </form>
    </StatusPage>
  );
}
