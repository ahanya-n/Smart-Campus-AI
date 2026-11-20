import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/app_user.dart';
import '../services/api_service.dart';
import '../utils/formatters.dart';
import 'admin_dashboard_screen.dart';
import 'academic_intelligence_screen.dart';
import 'attendance_screen.dart';
import 'campus_assistant_screen.dart';
import 'complaints_screen.dart';
import 'faculty_dashboard_screen.dart';
import 'feature_preview_screen.dart';
import 'library_screen.dart';
import 'notifications_screen.dart';
import 'timetable_screen.dart';
import 'transport_screen.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({
    super.key,
    required this.onOpenStudents,
    required this.onOpenProfile,
  });

  final VoidCallback onOpenStudents;
  final VoidCallback onOpenProfile;

  Future<void> _refresh(BuildContext context) async {
    try {
      await AppScope.read(context).auth.refreshUser();
    } on ApiException catch (e) {
      if (context.mounted && !e.isUnauthorized) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  void _open(BuildContext context, Widget screen) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
  }

  void _openPreview(BuildContext context, FeaturePreview feature) =>
      _open(context, FeaturePreviewScreen(feature: feature));

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.of(context).auth;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Smart Campus'),
        actions: [
          IconButton(
            tooltip: 'Attendance Notices',
            icon: const Icon(Icons.notifications_outlined),
            onPressed: () => _open(context, const NotificationsScreen()),
          ),
          IconButton(
            tooltip: 'Profile',
            onPressed: onOpenProfile,
            icon: const Icon(Icons.account_circle_outlined),
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: auth,
        builder: (context, _) {
          final user = auth.user;
          return RefreshIndicator(
            onRefresh: () => _refresh(context),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                if (user != null) ...[
                  _WelcomeCard(user: user),
                  const SizedBox(height: 16),
                  _AssistantHeroCard(
                    onTap: () => _open(context, const CampusAssistantScreen()),
                  ),
                ],
                if (user != null && user.isAdmin) ...[
                  const SizedBox(height: 28),
                  const _SectionHeader(
                    title: 'Administration',
                    icon: Icons.admin_panel_settings_rounded,
                  ),
                  const SizedBox(height: 12),
                  _TileGrid(
                    tiles: [
                      _FeatureTile(
                        icon: Icons.dashboard_customize_rounded,
                        title: 'Admin Console',
                        subtitle: 'Metrics, users & roles',
                        live: true,
                        onTap: () =>
                            _open(context, const AdminDashboardScreen()),
                      ),
                      _FeatureTile(
                        icon: Icons.vpn_key_rounded,
                        title: 'Student Linking',
                        subtitle: 'Generate link codes',
                        live: true,
                        onTap: () =>
                            _open(context, const AdminDashboardScreen()),
                      ),
                      _FeatureTile(
                        icon: Icons.insights_rounded,
                        title: 'Academic Intelligence',
                        subtitle: 'Risk & intervention overview',
                        live: true,
                        onTap: () =>
                            _open(context, const AcademicIntelligenceScreen()),
                      ),
                    ],
                  ),
                ],
                if (user != null && user.isFaculty) ...[
                  const SizedBox(height: 28),
                  const _SectionHeader(
                    title: 'Faculty Portal',
                    icon: Icons.co_present_rounded,
                  ),
                  const SizedBox(height: 12),
                  _TileGrid(
                    tiles: [
                      _FeatureTile(
                        icon: Icons.checklist_rounded,
                        title: 'Mark Attendance',
                        subtitle: 'Record class session',
                        live: true,
                        onTap: () =>
                            _open(context, const FacultyDashboardScreen()),
                      ),
                      _FeatureTile(
                        icon: Icons.calendar_month_rounded,
                        title: 'Teaching Schedule',
                        subtitle: 'Weekly timetable',
                        live: true,
                        onTap: () => _open(context, const TimetableScreen()),
                      ),
                      _FeatureTile(
                        icon: Icons.insights_rounded,
                        title: 'Class Intelligence',
                        subtitle: 'Students needing attention',
                        live: true,
                        onTap: () =>
                            _open(context, const AcademicIntelligenceScreen()),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 28),
                const _SectionHeader(
                  title: 'Academics',
                  icon: Icons.menu_book_rounded,
                ),
                const SizedBox(height: 12),
                _TileGrid(
                  tiles: [
                    _FeatureTile(
                      icon: Icons.smart_toy_rounded,
                      title: 'AI Assistant',
                      subtitle: 'Chat & timetable queries',
                      live: true,
                      onTap: () =>
                          _open(context, const CampusAssistantScreen()),
                    ),
                    if (user?.isStudent == true)
                      _FeatureTile(
                        icon: Icons.insights_rounded,
                        title: 'Academic Intelligence',
                        subtitle: 'Progress & personal mentor',
                        live: true,
                        onTap: () =>
                            _open(context, const AcademicIntelligenceScreen()),
                      ),
                    _FeatureTile(
                      icon: Icons.notification_important_rounded,
                      title: 'Attendance Notices',
                      subtitle: 'Weekly warning alerts',
                      live: true,
                      onTap: () => _open(context, const NotificationsScreen()),
                    ),
                    _FeatureTile(
                      icon: Icons.groups_rounded,
                      title: 'Student Directory',
                      subtitle: 'Browse all students',
                      live: true,
                      onTap: onOpenStudents,
                    ),
                    _FeatureTile(
                      icon: Icons.fact_check_rounded,
                      title: 'Attendance',
                      subtitle: 'Class attendance',
                      live: true,
                      onTap: () => _open(context, const AttendanceScreen()),
                    ),
                    _FeatureTile(
                      icon: Icons.calendar_month_rounded,
                      title: 'Timetable',
                      subtitle: 'Weekly schedule',
                      live: true,
                      onTap: () => _open(context, const TimetableScreen()),
                    ),
                    _FeatureTile(
                      icon: Icons.badge_rounded,
                      title: 'My Profile',
                      subtitle: 'Account details',
                      live: true,
                      onTap: onOpenProfile,
                    ),
                  ],
                ),
                const SizedBox(height: 28),
                const _SectionHeader(
                  title: 'Campus Services',
                  icon: Icons.apartment_rounded,
                ),
                const SizedBox(height: 12),
                _TileGrid(
                  tiles: [
                    _FeatureTile(
                      icon: Icons.local_library_rounded,
                      title: 'Library',
                      subtitle: 'Books & loans',
                      live: true,
                      onTap: () => _open(context, const LibraryScreen()),
                    ),
                    _FeatureTile(
                      icon: Icons.directions_bus_rounded,
                      title: 'Transport',
                      subtitle: 'Bus routes',
                      live: true,
                      onTap: () => _open(context, const TransportScreen()),
                    ),
                    if (user?.isStudent == true)
                      _FeatureTile(
                        icon: Icons.report_problem_rounded,
                        title: 'Complaints',
                        subtitle: 'Submit and track requests',
                        live: true,
                        onTap: () => _open(context, const ComplaintsScreen()),
                      ),
                    _FeatureTile(
                      icon: Icons.event_rounded,
                      title: 'Events',
                      subtitle: 'Campus events',
                      onTap: () => _openPreview(context, FeaturePreview.events),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                const _PreviewNote(),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _WelcomeCard extends StatelessWidget {
  const _WelcomeCard({required this.user});

  final AppUser user;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final onPrimary = scheme.onPrimary;
    final firstName = user.name.trim().split(RegExp(r'\s+')).first;

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            scheme.primary,
            Color.lerp(scheme.primary, Colors.black, 0.3)!,
          ],
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  greetingFor(DateTime.now()),
                  style: theme.textTheme.bodyLarge?.copyWith(
                    color: onPrimary.withValues(alpha: 0.85),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  firstName.isEmpty ? 'Welcome!' : 'Welcome, $firstName!',
                  style: theme.textTheme.headlineSmall?.copyWith(
                    color: onPrimary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 12),
                if (user.role.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: onPrimary.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      capitalize(user.role),
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: onPrimary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          CircleAvatar(
            radius: 30,
            backgroundColor: onPrimary.withValues(alpha: 0.2),
            child: Text(
              initialsOf(user.name),
              style: theme.textTheme.titleLarge?.copyWith(
                color: onPrimary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, required this.icon});

  final String title;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(icon, size: 20, color: theme.colorScheme.primary),
        const SizedBox(width: 8),
        Text(
          title,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}

class _TileGrid extends StatelessWidget {
  const _TileGrid({required this.tiles});

  final List<Widget> tiles;

  @override
  Widget build(BuildContext context) {
    return GridView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        mainAxisExtent: 148,
      ),
      children: tiles,
    );
  }
}

class _FeatureTile extends StatelessWidget {
  const _FeatureTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.live = false,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  /// true = connected to the backend; false = preview only.
  final bool live;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: live
                          ? scheme.primaryContainer
                          : scheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Icon(
                      icon,
                      color: live ? scheme.onPrimaryContainer : scheme.outline,
                    ),
                  ),
                  const Spacer(),
                  _StatusBadge(live: live),
                ],
              ),
              const Spacer(),
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.live});

  final bool live;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final background = live
        ? Colors.green.withValues(alpha: 0.15)
        : scheme.surfaceContainerHighest;
    final foreground = live ? Colors.green.shade700 : scheme.onSurfaceVariant;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        live ? 'Live' : 'Preview',
        style: TextStyle(
          color: foreground,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _PreviewNote extends StatelessWidget {
  const _PreviewNote();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline_rounded, color: scheme.onSecondaryContainer),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              '"Live" features use real data from the Smart Campus server. '
              '"Preview" features are not connected to the backend yet.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSecondaryContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AssistantHeroCard extends StatelessWidget {
  const _AssistantHeroCard({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(
          color: scheme.primary.withValues(alpha: 0.3),
          width: 1.5,
        ),
      ),
      color: scheme.primaryContainer.withValues(alpha: 0.35),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: scheme.primary,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: const Icon(
                  Icons.smart_toy_rounded,
                  color: Colors.white,
                  size: 26,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          'AI Campus Assistant',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: scheme.primary.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            'NEW',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              color: scheme.primary,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Ask attendance, next class & free-time slots',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(
                Icons.arrow_forward_ios_rounded,
                size: 16,
                color: scheme.primary,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
