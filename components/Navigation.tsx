"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
  Box,
  useTheme,
  useMediaQuery,
  alpha,
} from "@mui/material";
import {
  Menu as MenuIcon,
  Close as CloseIcon,
  Home as HomeIcon,
  Store as StoreIcon,
  AddCircle as CreateIcon,
  Dashboard as DashboardIcon,
  Analytics as AnalyticsIcon,
  Security as SecurityIcon,
  Info as LearnIcon,
  BugReport as BugIcon,
  Groups as PeopleIcon,
} from "@mui/icons-material";

import ConnectWallet from "./ConnectWallet";
import WalletAddress from "./WalletAddress";
import NetworkSwitcher from "./NetworkSwitcher";
import ThemeToggle from "./ThemeToggle";
import LanguageSwitcher from "./LanguageSwitcher";
import { useStellarWallet } from "./context/StellarWalletProvider";
import useFocusTrap from "./useFocusTrap";

export const Navigation: React.FC = () => {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const { rpcStatus } = useStellarWallet();

  const rpcStatusClasses = {
    connected: "bg-emerald-500/10 text-emerald-300 border-emerald-400/30",
    degraded: "bg-amber-500/10 text-amber-200 border-amber-400/30",
    offline: "bg-red-500/10 text-red-200 border-red-400/30",
  };

  const rpcStatusLabel = {
    connected: "Connected",
    degraded: "Degraded",
    offline: "Offline",
  };

  const navLinks = [
    { href: "/marketplace", label: "Marketplace", icon: <StoreIcon /> },
    { href: "/create", label: "Create Agent", icon: <CreateIcon /> },
    { href: "/dashboard", label: "Dashboard", icon: <DashboardIcon /> },
    { href: "/dashboard/referrals", label: "Affiliate", icon: <PeopleIcon /> },
    { href: "/analytics", label: "Analytics", icon: <AnalyticsIcon /> },
    { href: "/telemetry", label: "Telemetry", icon: <AnalyticsIcon /> },
    { href: "/security", label: "Security", icon: <SecurityIcon /> },
    { href: "/provenance", label: "Provenance", icon: <SecurityIcon /> },
    { href: "/portfolio", label: "Portfolio", icon: <DashboardIcon /> },
    { href: "/trading", label: "Trading" },
    { href: "/waitlist", label: "Waitlist", icon: <HomeIcon /> },
    { href: "/staking", label: "Staking", icon: <StoreIcon /> },
    { href: "/learn", label: "Learn", icon: <LearnIcon /> },
    { href: "/bug-report", label: "Report Bug", icon: <BugIcon /> },
    { href: "/bug-reports", label: "Bug Reports" },
    { href: "/submissions", label: "Submission Dashboard" },
    { href: "/settings/api-keys", label: "API Keys" },
  ];

  const drawerTrapRef = useFocusTrap<HTMLDivElement>({
    active: isDrawerOpen,
    onEscape: () => setIsDrawerOpen(false),
  });

  const toggleDrawer = (open: boolean) => (event: React.KeyboardEvent | React.MouseEvent) => {
    if (
      event.type === "keydown" &&
      ((event as React.KeyboardEvent).key === "Tab" || (event as React.KeyboardEvent).key === "Shift")
    ) {
      return;
    }
    setIsDrawerOpen(open);
  };

  return (
    <nav className="fixed top-0 w-full z-50 backdrop-blur-md bg-trellis-ground/80 border-b border-trellis-vine/20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link
            href="/"
            className="flex items-center gap-2 hover:opacity-80 transition-smooth"
          >
            <span className="text-2xl text-trellis-vine font-bold">*</span>
            <span className="glow-text font-bold text-xl tracking-tight">Trellis</span>
          </Link>

          {/* Desktop Menu */}
          <div className="hidden md:flex gap-8 items-center">
            {navLinks.slice(0, 5).map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-medium hover:text-trellis-vine transition-smooth relative group"
              >
                {link.label}
                <span className="absolute -bottom-1 start-0 w-0 h-0.5 bg-trellis-vine transition-all group-hover:w-full" />
              </Link>
            ))}
          </div>

          {/* Right side controls */}
          <div className="flex gap-3 items-center">
            <div className="hidden md:flex gap-3 items-center">
              <span
                className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide ${rpcStatusClasses[rpcStatus.status]}`}
                title={rpcStatus.warning || `RPC status: ${rpcStatus.status}`}
              >
                <span className="h-2 w-2 rounded-full bg-current" />
                {rpcStatusLabel[rpcStatus.status]}
              </span>
              <ThemeToggle />
              <LanguageSwitcher />
              <NetworkSwitcher />
              <ConnectWallet />
              <WalletAddress />
            </div>

            {/* Mobile Menu Button */}
            <IconButton
              edge="end"
              color="inherit"
              aria-label="menu"
              onClick={toggleDrawer(true)}
              className="md:hidden ms-2"
              sx={{
                color: "white",
                "&:hover": { backgroundColor: "rgba(255,255,255,0.1)" },
              }}
            >
              <MenuIcon />
            </IconButton>
          </div>
        </div>
      </div>

      {/* Mobile Drawer */}
      <Drawer
        anchor={theme.direction === "rtl" ? "left" : "right"}
        open={isDrawerOpen}
        onClose={toggleDrawer(false)}
        PaperProps={{
          sx: {
            width: "280px",
            backgroundColor: "#070F0D",
            backgroundImage: "linear-gradient(180deg, #0E1A16 0%, #070F0D 100%)",
            color: "white",
            borderInlineStart: "1px solid rgba(79, 191, 155, 0.2)",
          },
        }}
      >
        <Box
          ref={drawerTrapRef}
          sx={{ width: "auto", p: 2 }}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation drawer"
          onClick={toggleDrawer(false)}
          onKeyDown={toggleDrawer(false)}
        >
          <Box className="flex justify-between items-center mb-6">
            <span className="glow-text font-bold text-lg">Navigation</span>
            <IconButton onClick={toggleDrawer(false)} sx={{ color: "white" }} aria-label="Close navigation drawer">
              <CloseIcon />
            </IconButton>
          </Box>

          <List sx={{ mb: 4 }}>
            {navLinks.map((link) => (
              <ListItem key={link.href} disablePadding>
                <Link href={link.href} passHref style={{ width: "100%", textDecoration: "none", color: "inherit" }}>
                  <ListItemButton
                    sx={{
                      borderRadius: "8px",
                      mb: 1,
                      "&:hover": {
                        backgroundColor: alpha(theme.palette.primary.main, 0.1),
                        color: theme.palette.primary.main,
                      },
                    }}
                  >
                    <Box className="me-2" sx={{ color: "inherit", opacity: 0.8 }}>{link.icon}</Box>
                    <ListItemText primary={link.label} />
                  </ListItemButton>
                </Link>
              </ListItem>
            ))}
          </List>

          <Box sx={{ pt: 2, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <Box className="flex flex-col gap-4 mt-4">
              <div className="flex items-center justify-between px-2">
                <span className="text-sm text-gray-400">Appearance</span>
                <ThemeToggle />
              </div>
              <div className="flex items-center justify-between px-2">
                <span className="text-sm text-gray-400">Language</span>
                <LanguageSwitcher />
              </div>
              <Box sx={{ mt: 2 }}>
                <NetworkSwitcher className="w-full mb-3" />
                <ConnectWallet className="w-full mb-3" />
                <WalletAddress />
              </Box>
            </Box>
          </Box>
        </Box>
      </Drawer>
    </nav>
  );
};

export default Navigation;
