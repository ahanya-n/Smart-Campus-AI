import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../services/api_service.dart';
import '../widgets/state_views.dart';

/// Admin console for viewing metrics, managing users, assigning roles, and issuing student link codes.
class AdminDashboardScreen extends StatefulWidget {
  const AdminDashboardScreen({super.key});

  @override
  State<AdminDashboardScreen> createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  Map<String, dynamic>? _stats;
  bool _loadingStats = true;
  String? _statsError;

  List<Map<String, dynamic>> _users = [];
  bool _loadingUsers = true;
  String? _usersError;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadStats();
    _loadUsers();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadStats() async {
    setState(() {
      _loadingStats = true;
      _statsError = null;
    });

    final api = AppScope.read(context).api;
    try {
      final res = await api.getAdminStats();
      if (mounted) setState(() => _stats = res);
    } on ApiException catch (e) {
      if (mounted) setState(() => _statsError = e.message);
    } finally {
      if (mounted) setState(() => _loadingStats = false);
    }
  }

  Future<void> _loadUsers() async {
    setState(() {
      _loadingUsers = true;
      _usersError = null;
    });

    final api = AppScope.read(context).api;
    try {
      final res = await api.getAdminUsers();
      if (mounted) setState(() => _users = res);
    } on ApiException catch (e) {
      if (mounted) setState(() => _usersError = e.message);
    } finally {
      if (mounted) setState(() => _loadingUsers = false);
    }
  }

  Future<void> _changeRole(Map<String, dynamic> user) async {
    final currentRole = user['role'] ?? 'student';
    String selectedRole = currentRole;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text('Change Role: ${user['name']}'),
          content: RadioGroup<String>(
            groupValue: selectedRole,
            onChanged: (val) {
              if (val != null) {
                setDialogState(() => selectedRole = val);
              }
            },
            child: const Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                RadioListTile<String>(
                  title: Text('Student'),
                  value: 'student',
                ),
                RadioListTile<String>(
                  title: Text('Faculty'),
                  value: 'faculty',
                ),
                RadioListTile<String>(
                  title: Text('Admin'),
                  value: 'admin',
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Save Role'),
            ),
          ],
        ),
      ),
    );

    if (!mounted) return;
    if (confirmed == true && selectedRole != currentRole) {
      final api = AppScope.read(context).api;
      try {
        await api.updateRole(user['id'], selectedRole);
        _loadUsers();
        _loadStats();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Updated ${user['name']} to $selectedRole')),
          );
        }
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  Future<void> _assignSubjects(Map<String, dynamic> user) async {
    final controller = TextEditingController(
      text: (user['assigned_subject_codes'] as List? ?? []).join(', '),
    );

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Assign Subjects: ${user['name']}'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(
            labelText: 'Subjects (comma-separated)',
            hintText: 'e.g. MCA401, MCA402',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Save'),
          ),
        ],
      ),
    );

    if (!mounted) return;
    if (confirmed == true) {
      final codes = controller.text
          .split(',')
          .map((e) => e.trim().toUpperCase())
          .where((e) => e.isNotEmpty)
          .toList();

      final api = AppScope.read(context).api;
      try {
        await api.assignSubjects(user['id'], codes);
        _loadUsers();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Subjects updated successfully')),
          );
        }
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  Future<void> _linkStudentDialog(Map<String, dynamic> user) async {
    final controller = TextEditingController(text: user['student_id'] ?? '');

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Link Student: ${user['name']}'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(
            labelText: 'Student ID (leave empty to unlink)',
            hintText: 'e.g. MCA001',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Save Link'),
          ),
        ],
      ),
    );

    if (!mounted) return;
    if (confirmed == true) {
      final sid = controller.text.trim().isEmpty ? null : controller.text.trim();
      final api = AppScope.read(context).api;
      try {
        await api.linkStudent(user['id'], sid);
        _loadUsers();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(sid == null ? 'Student unlinked' : 'Linked to $sid')),
          );
        }
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  Future<void> _issueLinkCode() async {
    final controller = TextEditingController();

    final sid = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Generate One-Time Link Code'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(
            labelText: 'Student ID',
            hintText: 'e.g. MCA001',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Generate Code'),
          ),
        ],
      ),
    );

    if (!mounted) return;
    if (sid != null && sid.isNotEmpty) {
      final api = AppScope.read(context).api;
      try {
        final code = await api.generateLinkCode(sid);
        if (mounted) {
          showDialog(
            context: context,
            builder: (ctx) => AlertDialog(
              icon: const Icon(Icons.key_rounded, size: 40, color: Colors.blue),
              title: Text('Link Code for $sid'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.blue.shade50,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: SelectableText(
                      code,
                      style: const TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Give this code to the student in person. It expires in 7 days.',
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
              actions: [
                FilledButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('Done'),
                ),
              ],
            ),
          );
        }
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  Future<void> _createUserDialog() async {
    final nameCtrl = TextEditingController();
    final emailCtrl = TextEditingController();
    final passCtrl = TextEditingController();
    String selectedRole = 'student';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Create New Account'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Full Name',
                    prefixIcon: Icon(Icons.person_outline_rounded),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: emailCtrl,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(
                    labelText: 'Email Address',
                    prefixIcon: Icon(Icons.email_outlined),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: passCtrl,
                  obscureText: true,
                  decoration: const InputDecoration(
                    labelText: 'Password (min 8 chars)',
                    prefixIcon: Icon(Icons.lock_outline_rounded),
                  ),
                ),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  initialValue: selectedRole,
                  decoration: const InputDecoration(
                    labelText: 'Role',
                    prefixIcon: Icon(Icons.badge_outlined),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'student', child: Text('Student')),
                    DropdownMenuItem(value: 'faculty', child: Text('Faculty')),
                    DropdownMenuItem(value: 'admin', child: Text('Admin')),
                  ],
                  onChanged: (val) {
                    if (val != null) setDialogState(() => selectedRole = val);
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Create Account'),
            ),
          ],
        ),
      ),
    );

    if (!mounted) return;
    if (confirmed == true) {
      final name = nameCtrl.text.trim();
      final email = emailCtrl.text.trim();
      final pass = passCtrl.text;
      if (name.isEmpty || email.isEmpty || pass.length < 8) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Please fill all fields. Password must be at least 8 characters.'),
            backgroundColor: Colors.red,
          ),
        );
        return;
      }
      final api = AppScope.read(context).api;
      try {
        await api.createUser(name: name, email: email, password: pass, role: selectedRole);
        _loadUsers();
        _loadStats();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Account created for $name ($selectedRole)')),
          );
        }
      } on ApiException catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Admin Console'),
        bottom: TabBar(
          controller: _tabController,
          tabs: const [
            Tab(icon: Icon(Icons.insights_rounded), text: 'Metrics'),
            Tab(icon: Icon(Icons.manage_accounts_rounded), text: 'Users'),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Create user',
            icon: const Icon(Icons.person_add_rounded),
            onPressed: _createUserDialog,
          ),
          IconButton(
            tooltip: 'Issue student link code',
            icon: const Icon(Icons.vpn_key_outlined),
            onPressed: _issueLinkCode,
          ),
        ],
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildMetricsTab(),
          _buildUsersTab(),
        ],
      ),
    );
  }

  Widget _buildMetricsTab() {
    if (_loadingStats) return const LoadingView(message: 'Loading metrics...');
    if (_statsError != null) {
      return MessageView(
        icon: Icons.error_outline_rounded,
        title: 'Could not load metrics',
        message: _statsError!,
        actionLabel: 'Retry',
        onAction: _loadStats,
        isError: true,
      );
    }

    final stats = _stats ?? {};

    return RefreshIndicator(
      onRefresh: _loadStats,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          GridView.count(
            crossAxisCount: 2,
            crossAxisSpacing: 12,
            mainAxisSpacing: 12,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            children: [
              _StatTile(
                icon: Icons.groups_rounded,
                title: 'Total Students',
                value: '${stats['total_students'] ?? 0}',
                color: Colors.blue,
              ),
              _StatTile(
                icon: Icons.person_pin_rounded,
                title: 'Faculty Members',
                value: '${stats['total_faculty'] ?? 0}',
                color: Colors.purple,
              ),
              _StatTile(
                icon: Icons.menu_book_rounded,
                title: 'Subjects',
                value: '${stats['total_subjects'] ?? 0}',
                color: Colors.indigo,
              ),
              _StatTile(
                icon: Icons.class_rounded,
                title: 'Classes',
                value: '${stats['total_classes'] ?? 0}',
                color: Colors.deepOrange,
              ),
              _StatTile(
                icon: Icons.account_circle_rounded,
                title: 'Total Accounts',
                value: '${stats['total_users'] ?? 0}',
                color: Colors.teal,
              ),
              _StatTile(
                icon: Icons.fact_check_rounded,
                title: 'Attendance Sessions',
                value: '${stats['total_attendance_sessions'] ?? 0}',
                color: Colors.green,
              ),
              _StatTile(
                icon: Icons.calendar_month_rounded,
                title: 'Classes Scheduled',
                value: '${stats['total_classes_scheduled'] ?? 0}',
                color: Colors.orange,
              ),
              _StatTile(
                icon: Icons.local_library_rounded,
                title: 'Catalog Books',
                value: '${stats['total_books'] ?? 0}',
                color: Colors.indigo,
              ),
            ],
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            icon: const Icon(Icons.vpn_key_rounded),
            label: const Text('Generate Student Link Code'),
            onPressed: _issueLinkCode,
          ),
        ],
      ),
    );
  }

  Widget _buildUsersTab() {
    if (_loadingUsers) return const LoadingView(message: 'Loading users...');
    if (_usersError != null) {
      return MessageView(
        icon: Icons.error_outline_rounded,
        title: 'Could not load users',
        message: _usersError!,
        actionLabel: 'Retry',
        onAction: _loadUsers,
        isError: true,
      );
    }

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return RefreshIndicator(
      onRefresh: _loadUsers,
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _users.length,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          final user = _users[index];
          final role = user['role'] ?? 'student';
          final sid = user['student_id'];
          final subjects = (user['assigned_subject_codes'] as List? ?? []);

          return Card(
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: BorderSide(color: scheme.outlineVariant),
            ),
            child: ListTile(
              title: Text(
                user['name'] ?? '',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(user['email'] ?? ''),
                  if (role == 'student' && user['registration_number'] != null) ...[
                    const SizedBox(height: 4),
                    Text('Registration: ${user['registration_number']}'),
                  ],
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: role == 'admin'
                              ? Colors.red.shade100
                              : role == 'faculty'
                                  ? Colors.purple.shade100
                                  : Colors.blue.shade100,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          role.toUpperCase(),
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w800,
                            color: role == 'admin'
                                ? Colors.red.shade900
                                : role == 'faculty'
                                    ? Colors.purple.shade900
                                    : Colors.blue.shade900,
                          ),
                        ),
                      ),
                      if (sid != null) ...[
                        const SizedBox(width: 8),
                        Text('Linked: $sid',
                            style: const TextStyle(fontWeight: FontWeight.w600)),
                      ],
                    ],
                  ),
                  if (role == 'faculty' && subjects.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text('Subjects: ${subjects.join(', ')}',
                        style: theme.textTheme.bodySmall),
                  ],
                  if (role == 'faculty') ...[
                    const SizedBox(height: 4),
                    Text(
                      [
                        user['faculty_id'],
                        user['department'],
                        user['designation'],
                        if ((user['assigned_class_ids'] as List? ?? []).isNotEmpty)
                          'Classes: ${(user['assigned_class_ids'] as List).join(', ')}',
                      ].whereType<String>().where((value) => value.isNotEmpty).join(' · '),
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ],
              ),
              trailing: PopupMenuButton<String>(
                onSelected: (val) {
                  if (val == 'role') _changeRole(user);
                  if (val == 'subjects') _assignSubjects(user);
                  if (val == 'link') _linkStudentDialog(user);
                },
                itemBuilder: (ctx) => [
                  const PopupMenuItem(
                    value: 'role',
                    child: Text('Change Role'),
                  ),
                  if (role == 'faculty')
                    const PopupMenuItem(
                      value: 'subjects',
                      child: Text('Assign Subjects'),
                    ),
                  if (role == 'student')
                    PopupMenuItem(
                      value: 'link',
                      child: Text(sid == null ? 'Link Student Record' : 'Edit Student Link'),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({
    required this.icon,
    required this.title,
    required this.value,
    required this.color,
  });

  final IconData icon;
  final String title;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Icon(icon, color: color, size: 28),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                value,
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w800,
                  color: color,
                ),
              ),
              Text(
                title,
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
