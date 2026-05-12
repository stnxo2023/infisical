/* eslint-disable react/jsx-props-no-spreading */
import { useEffect, useState } from "react";
import ReactCodeInput from "react-code-input";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import axios from "axios";

import { Button, Card, CardContent, CardHeader, CardTitle, FieldError } from "@app/components/v3";
import { useSendVerificationEmail, useVerifySignupEmailVerificationCode } from "@app/hooks/api";

import SecurityClient from "../utilities/SecurityClient";

// Matches v3 input theme: transparent bg, border (#2b2c30), foreground text (#ebebeb), ring on focus (#2d2f33)
const codeInputStyle = {
  inputStyle: {
    fontFamily: "monospace",
    margin: "4px",
    MozAppearance: "textfield",
    width: "55px",
    borderRadius: "6px",
    fontSize: "24px",
    height: "55px",
    paddingLeft: "7",
    backgroundColor: "transparent",
    color: "#ebebeb",
    border: "1px solid #2b2c30",
    textAlign: "center",
    outlineColor: "#2d2f33",
    borderColor: "#2b2c30"
  }
} as const;
const codeInputStylePhone = {
  inputStyle: {
    fontFamily: "monospace",
    margin: "4px",
    MozAppearance: "textfield",
    width: "40px",
    borderRadius: "6px",
    fontSize: "24px",
    height: "40px",
    paddingLeft: "7",
    backgroundColor: "transparent",
    color: "#ebebeb",
    border: "1px solid #2b2c30",
    textAlign: "center",
    outlineColor: "#2d2f33",
    borderColor: "#2b2c30"
  }
} as const;

interface CodeInputStepProps {
  email: string;
  onComplete: () => void;
  initialCooldown: number;
}

export default function CodeInputStep({
  email,
  onComplete,
  initialCooldown
}: CodeInputStepProps): JSX.Element {
  const { mutateAsync: resendEmail, isPending: isResending } = useSendVerificationEmail();
  const {
    mutateAsync: verifyCode,
    isPending: isVerifying,
    isError: isCodeError
  } = useVerifySignupEmailVerificationCode();
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(initialCooldown);
  const { t } = useTranslation();

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setInterval(() => setCooldown((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleVerify = async () => {
    const { token } = await verifyCode({ email, code });
    SecurityClient.setSignupToken(token);
    onComplete();
  };

  const handleResend = async () => {
    try {
      const { cooldownSeconds } = await resendEmail({ email });
      setCooldown(cooldownSeconds);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const remaining = err.response?.data?.details?.cooldownSeconds;
        if (typeof remaining === "number") {
          setCooldown(remaining);
        }
      }
    }
  };

  let resendLabel = t("signup.step2-resend-submit");
  if (isResending) resendLabel = t("signup.step2-resend-progress");
  else if (cooldown > 0) resendLabel = `${t("signup.step2-resend-submit")} (${cooldown}s)`;

  return (
    <div className="mx-auto flex w-full flex-col items-center justify-center">
      <Card className="mx-auto w-full max-w-md items-stretch gap-0 p-6">
        <CardHeader className="mb-2 gap-2">
          <CardTitle className="bg-linear-to-b from-white to-bunker-200 bg-clip-text text-center text-[1.55rem] font-medium text-transparent">
            {t("signup.step2-message")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-md my-1 flex justify-center font-medium text-foreground">{email}</p>
          <div className="mx-auto hidden w-max min-w-[20rem] md:block">
            <ReactCodeInput
              name=""
              inputMode="tel"
              type="text"
              fields={6}
              onChange={setCode}
              {...codeInputStyle}
              className="code-input-v3 mt-6 mb-2"
            />
          </div>
          <div className="mx-auto mt-4 block w-max md:hidden">
            <ReactCodeInput
              name=""
              inputMode="tel"
              type="text"
              fields={6}
              onChange={setCode}
              {...codeInputStylePhone}
              className="code-input-v3 mt-2 mb-2"
            />
          </div>
          {isCodeError && <FieldError>{t("signup.step2-code-error")}</FieldError>}
          <div className="mt-4 w-full">
            <Button
              type="submit"
              onClick={handleVerify}
              variant="project"
              size="lg"
              isFullWidth
              isPending={isVerifying}
              isDisabled={isVerifying}
            >
              {String(t("signup.verify"))}
            </Button>
          </div>
          <div className="mt-6 flex flex-col items-center gap-2 text-xs text-label">
            <div className="flex flex-row items-baseline gap-1">
              <button disabled={isResending || cooldown > 0} onClick={handleResend} type="button">
                <span
                  className={
                    cooldown > 0
                      ? "text-label/60"
                      : "cursor-pointer duration-200 hover:text-foreground hover:underline hover:decoration-project/45 hover:underline-offset-2"
                  }
                >
                  {t("signup.step2-resend-alert")} {resendLabel}
                </span>
              </button>
            </div>
            <Link
              to="/login"
              className="cursor-pointer duration-200 hover:text-foreground hover:underline hover:decoration-project/45 hover:underline-offset-2"
            >
              Have an account? Log in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
