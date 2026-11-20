import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../services/api_service.dart';
import '../utils/formatters.dart';

/// Shows the signed-in user from GET /me and the logout button.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _studentIdController = TextEditingController();
  final _linkCodeController = TextEditingController();
  bool _linking = false;
  String? _linkError;

  @override
  void dispose() {
    _studentIdController.dispose();
    _linkCodeController.dispose();
    super.dispose();
  }

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

  Future<void> _linkStudent(BuildContext context) async {
    final auth = AppScope.read(context).auth;
    setState(() {
      _linking = true;
      _linkError = null;
    });
    try {
      await auth.linkStudentRecord(
        studentId: _studentIdController.text.trim(),
        linkCode: _linkCodeController.text.trim(),
      );
      _studentIdController.clear();
      _linkCodeController.clear();
    } on ApiException catch (error) {
      if (error.isUnauthorized) {
        await auth.logout();
        return;
      }
      if (mounted) setState(() => _linkError = error.message);
    } finally {
      if (mounted) setState(() => _linking = false);
    }
  }

  Future<void> _confirmLogout(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(Icons.logout_rounded),
        title: const Text('Sign out?'),
        content: const Text('You will need to sign in again to use the app.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      await AppScope.read(context).auth.logout();
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListenableBuilder(
        listenable: scope.auth,
        builder: (context, _) {
          final user = scope.auth.user;
          if (user == null) return const SizedBox.shrink();

          return RefreshIndicator(
            onRefresh: () => _refresh(context),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                const SizedBox(height: 8),
                Center(
                  child: CircleAvatar(
                    radius: 48,
                    backgroundColor: scheme.primary,
                    child: Text(
                      initialsOf(user.name),
                      style: theme.textTheme.headlineMedium?.copyWith(
                        color: scheme.onPrimary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  user.name,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.headlineSmall
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 4),
                Text(
                  user.email,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
                if (user.role.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Center(
                    child: Chip(
                      avatar: Icon(Icons.verified_user_rounded,
                          size: 18, color: scheme.primary),
                      label: Text(capitalize(user.role)),
                    ),
                  ),
                ],
                const SizedBox(height: 24),
                _SectionCard(
                  title: 'Account',
                  children: [
                    _InfoTile(
                      icon: Icons.person_outline_rounded,
                      label: 'Name',
                      value: user.name,
                    ),
                    _InfoTile(
                      icon: Icons.email_outlined,
                      label: 'Email',
                      value: user.email,
                    ),
                    _InfoTile(
                      icon: Icons.shield_outlined,
                      label: 'Role',
                      value: capitalize(user.role),
                    ),
                    if (user.studentId?.isNotEmpty == true)
                      _InfoTile(
                        icon: Icons.badge_outlined,
                        label: 'Student ID',
                        value: user.studentId!,
                      ),
                  ],
                ),
                if (user.isStudent && user.studentId?.isNotEmpty != true) ...[
                  const SizedBox(height: 16),
                  _SectionCard(
                    title: 'Link student record',
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const Text(
                              'Enter your student ID and the one-time code issued by your college admin.',
                            ),
                            const SizedBox(height: 12),
                            TextField(
                              key: const Key('student_link_id'),
                              controller: _studentIdController,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Student ID',
                              ),
                            ),
                            const SizedBox(height: 12),
                            TextField(
                              key: const Key('student_link_code'),
                              controller: _linkCodeController,
                              textCapitalization: TextCapitalization.characters,
                              decoration: const InputDecoration(
                                labelText: 'One-time link code',
                              ),
                            ),
                            if (_linkError != null) ...[
                              const SizedBox(height: 8),
                              Text(
                                _linkError!,
                                style: TextStyle(color: scheme.error),
                              ),
                            ],
                            const SizedBox(height: 12),
                            FilledButton(
                              key: const Key('student_link_submit'),
                              onPressed: _linking
                                  ? null
                                  : () => _linkStudent(context),
                              child: Text(
                                _linking ? 'Linking…' : 'Link student record',
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 16),
                _SectionCard(
                  title: 'App',
                  children: [
                    _InfoTile(
                      icon: Icons.dns_outlined,
                      label: 'Server',
                      value: scope.api.baseUrl,
                    ),
                    const _InfoTile(
                      icon: Icons.info_outline_rounded,
                      label: 'Version',
                      value: '1.0.0',
                    ),
                  ],
                ),
                const SizedBox(height: 28),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.tonalIcon(
                    key: const Key('logout_button'),
                    style: FilledButton.styleFrom(
                      backgroundColor: scheme.errorContainer,
                      foregroundColor: scheme.onErrorContainer,
                    ),
                    onPressed: () => _confirmLogout(context),
                    icon: const Icon(Icons.logout_rounded),
                    label: const Text('Sign out'),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 8),
          child: Text(
            title,
            style: theme.textTheme.titleSmall?.copyWith(
              color: theme.colorScheme.primary,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        Card(child: Column(children: children)),
      ],
    );
  }
}

class _InfoTile extends StatelessWidget {
  const _InfoTile({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(label),
      subtitle: Text(value.isEmpty ? '-' : value),
    );
  }
}
