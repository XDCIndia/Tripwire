import Link from "next/link";

const GROUPS = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "/#architecture" },
      { label: "Documentation", href: "/docs" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Getting started", href: "/docs" },
      { label: "Policy reference", href: "/docs" },
      { label: "Support", href: "/support" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About Us", href: "/" },
      { label: "Careers", href: "/" },
      { label: "Contact", href: "/support" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/" },
      { label: "Terms of Service", href: "/" },
      { label: "Cookie Policy", href: "/" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="pt-10 lg:pt-20 border-t border-white/20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 pb-12 lg:pb-24 gap-8 lg:gap-4">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="mb-4 font-semibold text-white text-sm">
                {group.title}
              </h3>
              <ul className="space-y-3">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-zinc-400 block text-sm leading-5 hover:text-white transition"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pt-4 pb-8 border-t flex flex-col sm:flex-row gap-5 justify-between border-white/20">
          <p className="text-zinc-400 text-sm leading-5 transition">
            &copy; {new Date().getFullYear()} Tripwire. All rights reserved.
          </p>
          <div className="flex gap-4 items-center">
            <Link
              href="/"
              className="text-zinc-400 text-sm leading-5 hover:text-white transition"
            >
              Privacy Policy
            </Link>
            <Link
              href="/"
              className="text-zinc-400 text-sm leading-5 hover:text-white transition"
            >
              Terms of Service
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
