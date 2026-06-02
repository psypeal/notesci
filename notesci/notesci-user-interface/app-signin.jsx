// app.jsx — composes the V1 design canvas: core flows, adjacent screens,
// onboarding, in-app invite-share, mobile/tablet, plus tweaks.

const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window;
const { TweaksPanel, useTweaks, TweakSection, TweakRadio, TweakToggle, TweakSelect, TweakText } = window;
const { V1, V1Tablet, V1Mobile, COPY, TWEAK_DEFAULTS } = window;
const {
  ForgotPassword, ResetSent, SetNewPassword, VerifyEmail,
  InviteLanding, AlreadyClaimed, ExpiredInvite,
  Onboarding, InviteFriends,
} = window;
const {
  ForgotPasswordM, ResetSentM, SetNewPasswordM, VerifyEmailM,
  InviteLandingM, AlreadyClaimedM, ExpiredInviteM,
  OnboardingM, InviteFriendsM,
} = window;
const {
  SignInLoading, SignInError, SignUpInvalidCode, SignUpEmailExists,
  InviteFriendsEmpty, InviteSentToast,
} = window;
const { EmailInvite, EmailReset, EmailVerify } = window;

const App = () => {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const hero = {
    paper: tweaks.paper,
    showStats: tweaks.showStats,
    showIssue: tweaks.showIssue,
    treatment: tweaks.heroTreatment,
    headline: tweaks.headline,
  };

  return (
    <>
      <DesignCanvas>
        {/* ─── Core flows ─── */}
        <DCSection id="core" title="V1 · Editorial · core flows" subtitle="Sign in · claim invite · waitlist · 1440×900">
          <DCArtboard id="signin"   label="Sign in"        width={1440} height={900}><V1 mode="signin"   hero={hero}/></DCArtboard>
          <DCArtboard id="signup"   label="Claim invite"   width={1440} height={900}><V1 mode="signup"   hero={hero}/></DCArtboard>
          <DCArtboard id="waitlist" label="Waitlist"       width={1440} height={900}><V1 mode="waitlist" hero={hero}/></DCArtboard>
          <DCPostIt top={20} right={-30} rotate={3} width={210}>
            Three core modes share the editorial split. Hero panel is tweakable — try the tweaks panel.
          </DCPostIt>
        </DCSection>

        {/* ─── Invite-link landing ─── */}
        <DCSection id="landing" title="Invite-link landing" subtitle="When the URL has the code in it, e.g. notesci.com/invite/jin?c=NS-7K2X">
          <DCArtboard id="invite-landing" label="Invite landing" width={1440} height={900}><InviteLanding/></DCArtboard>
          <DCPostIt top={10} right={-30} rotate={-2} width={220}>
            Code chip auto-validates. From here, the user goes straight into "Claim invite" with the code pre-filled.
          </DCPostIt>
        </DCSection>

        {/* ─── Password reset trio ─── */}
        <DCSection id="reset" title="Password reset" subtitle="Forgot · sent · set new">
          <DCArtboard id="forgot"   label="Forgot password"   width={1440} height={900}><ForgotPassword/></DCArtboard>
          <DCArtboard id="sent"     label="Reset sent"        width={1440} height={900}><ResetSent/></DCArtboard>
          <DCArtboard id="setnew"   label="Set new password"  width={1440} height={900}><SetNewPassword/></DCArtboard>
        </DCSection>

        {/* ─── Verify + errors ─── */}
        <DCSection id="status" title="Status & error states" subtitle="Verify email · already-claimed · expired invite">
          <DCArtboard id="verify"   label="Verify email"      width={1440} height={900}><VerifyEmail/></DCArtboard>
          <DCArtboard id="claimed"  label="Already claimed"   width={1440} height={900}><AlreadyClaimed/></DCArtboard>
          <DCArtboard id="expired"  label="Expired invite"    width={1440} height={900}><ExpiredInvite/></DCArtboard>
        </DCSection>

        {/* ─── Onboarding ─── */}
        <DCSection id="onb" title="Post-claim onboarding" subtitle="Single skippable step · every field is optional">
          <DCArtboard id="onboarding" label="Onboarding · 1 step" width={1440} height={900}><Onboarding/></DCArtboard>
          <DCPostIt top={10} right={-30} rotate={2} width={220}>
            Every field has a SKIP link. The whole step can be skipped wholesale via the top-right "SKIP · ADD LATER" link.
          </DCPostIt>
        </DCSection>

        {/* ─── In-app invite share ─── */}
        <DCSection id="invites" title="In-app · invite friends" subtitle="Each member gets 3 invites; tracks who's joined">
          <DCArtboard id="invite-friends" label="Invite friends" width={1440} height={900}><InviteFriends/></DCArtboard>
        </DCSection>

        {/* ─── Tablet ─── */}
        <DCSection id="tablet" title="Tablet · 834 × 1112" subtitle="Hero collapses above the form">
          <DCArtboard id="t-signin"   label="Sign in · tablet"      width={834} height={1112}><V1Tablet mode="signin"   hero={hero}/></DCArtboard>
          <DCArtboard id="t-signup"   label="Claim invite · tablet" width={834} height={1112}><V1Tablet mode="signup"   hero={hero}/></DCArtboard>
          <DCArtboard id="t-waitlist" label="Waitlist · tablet"     width={834} height={1112}><V1Tablet mode="waitlist" hero={hero}/></DCArtboard>
        </DCSection>

        {/* ─── Mobile ─── */}
        <DCSection id="mobile" title="Mobile · 390 × 844" subtitle="Single column, full-bleed">
          <DCArtboard id="m-signin"   label="Sign in · mobile"      width={390} height={844}><V1Mobile mode="signin"/></DCArtboard>
          <DCArtboard id="m-signup"   label="Claim invite · mobile" width={390} height={844}><V1Mobile mode="signup"/></DCArtboard>
          <DCArtboard id="m-waitlist" label="Waitlist · mobile"     width={390} height={844}><V1Mobile mode="waitlist"/></DCArtboard>
        </DCSection>

        {/* ─── Mobile · adjacent screens ─── */}
        <DCSection id="mobile-adj" title="Mobile · adjacent screens" subtitle="Reset, verify, errors, onboarding, invite-share">
          <DCArtboard id="m-landing" label="Invite landing · mobile" width={390} height={844}><InviteLandingM/></DCArtboard>
          <DCArtboard id="m-forgot"  label="Forgot · mobile"         width={390} height={844}><ForgotPasswordM/></DCArtboard>
          <DCArtboard id="m-sent"    label="Reset sent · mobile"     width={390} height={844}><ResetSentM/></DCArtboard>
          <DCArtboard id="m-setnew"  label="Set new · mobile"        width={390} height={844}><SetNewPasswordM/></DCArtboard>
          <DCArtboard id="m-verify"  label="Verify · mobile"         width={390} height={844}><VerifyEmailM/></DCArtboard>
          <DCArtboard id="m-claimed" label="Already claimed · mobile" width={390} height={844}><AlreadyClaimedM/></DCArtboard>
          <DCArtboard id="m-expired" label="Expired · mobile"        width={390} height={844}><ExpiredInviteM/></DCArtboard>
          <DCArtboard id="m-onb"     label="Onboarding · mobile"     width={390} height={844}><OnboardingM/></DCArtboard>
          <DCArtboard id="m-invites" label="Invite friends · mobile" width={390} height={844}><InviteFriendsM/></DCArtboard>
        </DCSection>

        {/* ─── Loading & inline-error states ─── */}
        <DCSection id="states" title="Loading & error states" subtitle="What it looks like during/after a failed submit">
          <DCArtboard id="s-loading"     label="Sign in · loading"        width={1440} height={900}><SignInLoading/></DCArtboard>
          <DCArtboard id="s-pwerror"     label="Sign in · wrong password" width={1440} height={900}><SignInError/></DCArtboard>
          <DCArtboard id="s-badcode"     label="Sign up · invalid code"   width={1440} height={900}><SignUpInvalidCode/></DCArtboard>
          <DCArtboard id="s-emailexists" label="Sign up · email in use"   width={1440} height={900}><SignUpEmailExists/></DCArtboard>
          <DCArtboard id="s-empty"       label="Invites · empty state"    width={1440} height={900}><InviteFriendsEmpty/></DCArtboard>
          <DCArtboard id="s-toast"       label="Invites · sent toast"     width={1440} height={900}><InviteSentToast/></DCArtboard>
        </DCSection>

        {/* ─── Email templates ─── */}
        <DCSection id="emails" title="Transactional emails" subtitle="600px content width · paste into your email service">
          <DCArtboard id="e-invite" label="Invite email" width={1440} height={900}><EmailInvite/></DCArtboard>
          <DCArtboard id="e-reset"  label="Password reset email" width={1440} height={900}><EmailReset/></DCArtboard>
          <DCArtboard id="e-verify" label="Verify email" width={1440} height={900}><EmailVerify/></DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel>
        <TweakSection title="Hero panel">
          <TweakRadio label="Paper tone" value={tweaks.paper} options={[
            { label: "Warm",  value: "warm"  },
            { label: "Sepia", value: "sepia" },
            { label: "Cool",  value: "cool"  },
          ]} onChange={v => setTweak("paper", v)}/>
          <TweakRadio label="Treatment" value={tweaks.heroTreatment} options={[
            { label: "Headline",  value: "headline"  },
            { label: "Pull-quote",value: "pullquote" },
            { label: "Mark only", value: "mark"      },
          ]} onChange={v => setTweak("heroTreatment", v)}/>
          <TweakText label="Headline copy" value={tweaks.headline} onChange={v => setTweak("headline", v)}/>
          <TweakToggle label="Stat strip" value={tweaks.showStats} onChange={v => setTweak("showStats", v)}/>
          <TweakToggle label="Vol/issue line" value={tweaks.showIssue} onChange={v => setTweak("showIssue", v)}/>
        </TweakSection>
      </TweaksPanel>
    </>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
