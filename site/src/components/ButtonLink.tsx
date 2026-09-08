"use client";

import Link from "next/link";
import { motion } from "motion/react";
import TextRoll from "./TextRoll";

const MotionLink = motion.create(Link);

type Props = {
  href?: string;
  text?: string;
  className?: string;
  children?: React.ReactNode;
  onClick?: () => void;
  "aria-label"?: string;
};

/**
 * Shared CTA. Renders a link when `href` is given, a button otherwise, and
 * rolls its label on hover — see [TextRoll].
 */
export default function ButtonLink({
  href,
  text,
  className,
  children,
  onClick,
  "aria-label": ariaLabel,
}: Props) {
  const content = children ?? text;

  const shared = {
    className: `cursor-pointer relative overflow-hidden group inline-flex items-center justify-center ${className ?? ""}`,
    initial: "initial",
    whileHover: "hover",
    onClick,
    "aria-label": ariaLabel,
  };

  if (!href) {
    return (
      <motion.button type="button" {...shared}>
        <TextRoll>{content}</TextRoll>
      </motion.button>
    );
  }

  return (
    <MotionLink href={href} {...shared}>
      <TextRoll>{content}</TextRoll>
    </MotionLink>
  );
}
